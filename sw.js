/* 체성분 트래커 Service Worker
 * 전략
 *  - HTML(내비게이션): 네트워크 우선 + 3초 타임아웃 → 실패/지연 시 캐시
 *    (온라인이면 항상 최신, 신호 약하면 3초 뒤 캐시로 즉시 전환)
 *  - CDN 스크립트/폰트: 캐시 우선 (버전 고정 URL이라 갱신 불필요)
 *  - API 호출(generativelanguage 등): 캐시 우회, 항상 네트워크
 * 캐시 버전을 올리면 이전 캐시는 activate 시 전부 삭제됨.
 */

const VERSION    = 'tazz-v3';
const SHELL      = VERSION + '-shell';
const ASSETS     = VERSION + '-assets';
const NET_TIMEOUT = 8000;   // 너무 짧으면 옛 캐시로 넘어가버림

// index.html은 설치 시점에 캐시하지 않는다.
// 설치 스냅샷이 이후 배포한 최신 파일을 계속 가리는 문제가 있었음.
// 네트워크에서 성공적으로 받아온 뒤에만 캐시에 넣는다.
const SHELL_URLS = [
  './manifest.json'
];

const ASSET_URLS = [
  'https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.js',
  'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js',
  'https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=Noto+Sans+KR:wght@300;400;500&display=swap'
];

// 캐시하지 않을 호스트 (AI API 등)
const BYPASS = [
  'generativelanguage.googleapis.com',
  'api.anthropic.com'
];

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const shell = await caches.open(SHELL);
    await shell.addAll(SHELL_URLS).catch(() => {});
    const assets = await caches.open(ASSETS);
    // 개별 실패가 전체를 막지 않도록 하나씩
    await Promise.all(ASSET_URLS.map(u =>
      assets.add(new Request(u, { mode: 'cors' })).catch(() => {})
    ));
  })());
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys.filter(k => !k.startsWith(VERSION)).map(k => caches.delete(k))
    );
    await self.clients.claim();
  })());
});

self.addEventListener('message', e => {
  if (e.data === 'skipWaiting') self.skipWaiting();
});

// 네트워크를 타임아웃과 경쟁시킴
function fetchWithTimeout(req, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms);
    fetch(req).then(res => { clearTimeout(timer); resolve(res); },
                    err => { clearTimeout(timer); reject(err); });
  });
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (BYPASS.some(h => url.hostname.includes(h))) return;

  // 1) HTML 내비게이션: 네트워크 우선(3초) → 캐시 폴백
  if (req.mode === 'navigate' ||
      (req.headers.get('accept') || '').includes('text/html')) {
    e.respondWith((async () => {
      try {
        const res = await fetchWithTimeout(req, NET_TIMEOUT);
        if (res && res.ok) {
          const cache = await caches.open(SHELL);
          cache.put('./index.html', res.clone());
        }
        return res;
      } catch (err) {
        const cached = await caches.match('./index.html') ||
                       await caches.match('./');
        if (cached) return cached;
        return new Response(
          '<meta charset="utf-8"><body style="background:#0d0d0f;color:#e5e5e5;' +
          'font-family:sans-serif;padding:2rem"><h3>오프라인</h3>' +
          '<p>한 번 온라인으로 접속하면 이후엔 오프라인에서도 열립니다.</p></body>',
          { headers: { 'Content-Type': 'text/html; charset=utf-8' } }
        );
      }
    })());
    return;
  }

  // 2) 그 외(스크립트·폰트·이미지): 캐시 우선 → 네트워크 후 캐시 저장
  e.respondWith((async () => {
    const cached = await caches.match(req);
    if (cached) return cached;
    try {
      const res = await fetch(req);
      if (res && (res.ok || res.type === 'opaque')) {
        const cache = await caches.open(ASSETS);
        cache.put(req, res.clone());
      }
      return res;
    } catch (err) {
      return cached || Response.error();
    }
  })());
});
