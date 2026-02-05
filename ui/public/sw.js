const CACHE_VERSION = "openclaw-control-v1";
const CORE_ASSETS = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./favicon.svg",
  "./favicon-32.png",
  "./apple-touch-icon.png",
  "./favicon.ico",
];

self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(caches.open(CACHE_VERSION).then((cache) => cache.addAll(CORE_ASSETS)));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key !== CACHE_VERSION).map((key) => caches.delete(key))),
      )
      .then(() => self.clients.claim()),
  );
});

function isStaticRequest(request) {
  return ["style", "script", "image", "font"].includes(request.destination);
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") {
    return;
  }

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) {
    return;
  }

  if (request.mode === "navigate") {
    event.respondWith(
      (async () => {
        try {
          const response = await fetch(request);
          if (response && response.ok) {
            event.waitUntil(
              caches.open(CACHE_VERSION).then((cache) => cache.put(request, response.clone())),
            );
          }
          return response;
        } catch {
          const cached = await caches.match("./index.html");
          return cached ?? Response.error();
        }
      })(),
    );
    return;
  }

  if (isStaticRequest(request)) {
    event.respondWith(
      (async () => {
        const cached = await caches.match(request);
        if (cached) {
          return cached;
        }
        const response = await fetch(request);
        if (response && response.ok) {
          event.waitUntil(
            caches.open(CACHE_VERSION).then((cache) => cache.put(request, response.clone())),
          );
        }
        return response;
      })(),
    );
  }
});
