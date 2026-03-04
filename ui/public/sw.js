// Service Worker - App shell caching only
// No conversation data is cached — only static assets for offline app launch

const CACHE_NAME = "claw-shell-v1";

// Cache app shell on install
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(["/", "/favicon.svg", "/favicon-32.png", "/apple-touch-icon.png"]);
    }),
  );
  self.skipWaiting();
});

// Clean old caches on activate
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)));
    }),
  );
  self.clients.claim();
});

// Network-first strategy: try network, fall back to cache
self.addEventListener("fetch", (event) => {
  // Only handle GET requests
  if (event.request.method !== "GET") {
    return;
  }

  // Skip WebSocket and API requests
  const url = new URL(event.request.url);
  if (url.pathname.startsWith("/api") || url.protocol === "ws:" || url.protocol === "wss:") {
    return;
  }

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        // Cache successful responses for navigation requests
        if (response.ok && event.request.mode === "navigate") {
          const responseClone = response.clone();
          void caches.open(CACHE_NAME).then((cache) => {
            void cache.put(event.request, responseClone);
          });
        }
        return response;
      })
      .catch(() => {
        // Offline: serve from cache
        return caches.match(event.request).then((cached) => {
          if (cached) {
            return cached;
          }
          // For navigation requests, serve the cached index page
          if (event.request.mode === "navigate") {
            return caches.match("/");
          }
          return new Response("Offline", { status: 503 });
        });
      }),
  );
});
