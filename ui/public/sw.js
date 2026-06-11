// OpenClaw Control – Service Worker
// Handles offline caching and push notifications.

const CACHE_NAME = "openclaw-control-v18";
const SERVICE_WORKER_SKIP_WAITING_MESSAGE = "OPENCLAW_CONTROL_SW_SKIP_WAITING";
const ASSET_MANIFEST_URL = "./asset-manifest.json";
const SERVICE_WORKER_UPDATE_QUERY = "__openclaw_sw_update";
const MOBILE_RESCUE_QUERY = "__openclaw_mobile_rescue";
const APP_SHELL_URLS = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./favicon.svg",
  "./favicon-32.png",
  "./apple-touch-icon.png",
];
const CRITICAL_ASSET_PATTERNS = [
  /\/assets\/index-[^/]+\.(?:js|css)$/i,
  /\/assets\/chat-[^/]+\.(?:js|css)$/i,
  /\/assets\/app-render-chat-controls-[^/]+\.js$/i,
];

function appShellUrl() {
  return new URL("./", self.registration.scope);
}

function assetManifestUrl() {
  return new URL(ASSET_MANIFEST_URL, self.registration.scope);
}

function sameOriginUiRequest(url) {
  if (url.origin !== self.location.origin) {
    return false;
  }
  if (
    url.pathname.startsWith("/api/") ||
    url.pathname.startsWith("/rpc") ||
    url.pathname.startsWith("/plugins/") ||
    url.pathname.startsWith("/__openclaw/")
  ) {
    return false;
  }
  return true;
}

function resolveSameOriginUiUrl(input) {
  try {
    const url = new URL(input, self.registration.scope);
    if (!sameOriginUiRequest(url)) {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}

function isCacheableAssetUrl(requestUrl) {
  try {
    return new URL(requestUrl, self.registration.scope).pathname.includes("/assets/");
  } catch {
    return false;
  }
}

function isCriticalAssetUrl(requestUrl) {
  return CRITICAL_ASSET_PATTERNS.some((pattern) => pattern.test(requestUrl));
}

function collectHtmlAssetUrls(html) {
  const urls = new Set();
  const assetReferencePattern = /\b(?:src|href)=["']([^"']*\/assets\/[^"']+)["']/gi;
  let match;
  while ((match = assetReferencePattern.exec(html)) !== null) {
    const requestUrl = resolveSameOriginUiUrl(match[1]);
    if (requestUrl && isCacheableAssetUrl(requestUrl)) {
      urls.add(requestUrl);
    }
  }
  return urls;
}

function collectManifestAssetUrls(manifest, options = {}) {
  const urls = new Set();
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    return urls;
  }

  for (const entry of Object.values(manifest)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      continue;
    }
    const candidatePaths = [];
    if (typeof entry.file === "string") {
      candidatePaths.push(entry.file);
    }
    for (const key of ["css", "assets"]) {
      if (Array.isArray(entry[key])) {
        candidatePaths.push(...entry[key].filter((value) => typeof value === "string"));
      }
    }

    const isCriticalEntry =
      entry.isEntry === true ||
      entry.src === "index.html" ||
      candidatePaths.some((candidatePath) => {
        const requestUrl = resolveSameOriginUiUrl(candidatePath);
        return requestUrl ? isCriticalAssetUrl(requestUrl) : false;
      });
    if (options.criticalOnly && !isCriticalEntry) {
      continue;
    }

    for (const candidatePath of candidatePaths) {
      const requestUrl = resolveSameOriginUiUrl(candidatePath);
      if (requestUrl && isCacheableAssetUrl(requestUrl)) {
        urls.add(requestUrl);
      }
    }
  }
  return urls;
}

async function cacheOne(cache, requestUrl, options = {}) {
  try {
    if (!options.forceRefresh && (await cache.match(requestUrl))) {
      return;
    }
    const response = await fetch(requestUrl, {
      cache: options.forceRefresh ? "no-store" : "force-cache",
    });
    if (response.ok) {
      await cache.put(requestUrl, response);
    }
  } catch {
    // Asset warming is best-effort. A later fetch event can still cache the file.
  }
}

async function cacheMany(cache, requestUrls, options = {}) {
  await Promise.all([...requestUrls].map((requestUrl) => cacheOne(cache, requestUrl, options)));
}

async function cacheHtmlAssets(cache, response) {
  try {
    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("text/html")) {
      return;
    }
    const html = await response.clone().text();
    await cacheMany(cache, collectHtmlAssetUrls(html));
  } catch {
    // Best-effort cache warming only.
  }
}

async function cacheAssetManifest(cache, options = {}) {
  try {
    const manifestRequestUrl = assetManifestUrl().toString();
    const response = await fetch(manifestRequestUrl, { cache: "no-store" });
    if (!response.ok) {
      return;
    }
    await cache.put(manifestRequestUrl, response.clone());
    const manifest = await response.json();
    await cacheMany(cache, collectManifestAssetUrls(manifest, options));
  } catch {
    // Vite manifest warming is optional. The cached shell remains valid without it.
  }
}

let assetWarmPromise = null;
function warmAppAssets() {
  assetWarmPromise ??= caches
    .open(CACHE_NAME)
    .then((cache) => cacheAssetManifest(cache))
    .finally(() => {
      assetWarmPromise = null;
    });
  return assetWarmPromise;
}

async function cacheFreshResponse(request, response) {
  if (!response.ok) {
    return response;
  }
  const cache = await caches.open(CACHE_NAME);
  await cache.put(request, response.clone());
  return response;
}

async function cacheNavigationResponse(cache, request, response) {
  await cache.put(appShellUrl().toString(), response.clone());
  await cache.put(request, response.clone());
  await cacheHtmlAssets(cache, response.clone());
  await cacheAssetManifest(cache, { criticalOnly: true });
}

async function refreshNavigationShell(request) {
  try {
    const response = await fetch(request, { cache: "no-store" });
    if (!response.ok) {
      return;
    }
    const cache = await caches.open(CACHE_NAME);
    await cacheNavigationResponse(cache, request, response);
  } catch {
    // Best-effort only. The cached app shell keeps repeat PWA launches usable
    // when the phone is reconnecting to the Tailnet or the Gateway is waking up.
  }
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      await Promise.all(
        APP_SHELL_URLS.map((url) => {
          const requestUrl = new URL(url, self.registration.scope).toString();
          return cacheOne(cache, requestUrl, { forceRefresh: true });
        }),
      );
      void cacheAssetManifest(cache, { criticalOnly: true });
    }),
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    Promise.all([
      caches
        .keys()
        .then((keys) =>
          Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))),
        ),
      "navigationPreload" in self.registration
        ? self.registration.navigationPreload.enable()
        : Promise.resolve(),
    ]),
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // Skip non-GET and cross-origin requests.
  if (event.request.method !== "GET" || !sameOriginUiRequest(url)) {
    return;
  }

  const acceptsHtml = event.request.headers.get("accept")?.includes("text/html") === true;
  const isNavigation = event.request.mode === "navigate" || acceptsHtml;

  // Explicit refresh probes bypass the cached shell so update checks always see
  // the latest production HTML.
  if (
    event.request.cache === "no-store" ||
    url.searchParams.has(SERVICE_WORKER_UPDATE_QUERY) ||
    url.searchParams.has(MOBILE_RESCUE_QUERY)
  ) {
    event.respondWith(
      fetch(event.request, { cache: "no-store" }).then(async (response) => {
        if (response.ok && isNavigation) {
          const cache = await caches.open(CACHE_NAME);
          await cacheNavigationResponse(cache, event.request, response.clone());
        }
        return response;
      }),
    );
    return;
  }

  if (isNavigation) {
    event.respondWith(
      caches.open(CACHE_NAME).then(async (cache) => {
        try {
          const response = await fetch(event.request, { cache: "no-store" });
          if (response.ok) {
            await cacheNavigationResponse(cache, event.request, response.clone());
            event.waitUntil(warmAppAssets());
            return response;
          }
        } catch {
          // Fall through to the cached shell when the Gateway is temporarily unavailable.
        }
        const cachedShell =
          (await cache.match(event.request)) ?? (await cache.match(appShellUrl().toString()));
        if (cachedShell) {
          event.waitUntil(Promise.all([refreshNavigationShell(event.request), warmAppAssets()]));
          return cachedShell;
        }
        return new Response("OpenClaw Dashboard is unavailable while offline.", {
          status: 503,
          headers: { "content-type": "text/plain; charset=utf-8" },
        });
      }),
    );
    return;
  }

  // Cache-first for hashed assets; network-first for HTML/other.
  if (url.pathname.includes("/assets/")) {
    event.respondWith(
      caches
        .match(event.request)
        .then(
          (cached) =>
            cached ||
            fetch(event.request).then((response) => cacheFreshResponse(event.request, response)),
        ),
    );
  } else {
    event.respondWith(
      fetch(event.request)
        .then((response) => cacheFreshResponse(event.request, response))
        .catch(() => caches.match(event.request)),
    );
  }
});

self.addEventListener("message", (event) => {
  const messageType = typeof event.data === "string" ? event.data : event.data?.type;
  if (messageType === SERVICE_WORKER_SKIP_WAITING_MESSAGE) {
    self.skipWaiting();
  }
});

// --- Web Push ---

self.addEventListener("push", (event) => {
  if (!event.data) {
    return;
  }

  let data;
  try {
    data = event.data.json();
  } catch {
    data = { title: "OpenClaw", body: event.data.text() };
  }

  const title = data.title || "OpenClaw";
  const options = {
    body: data.body || "",
    icon: "./apple-touch-icon.png",
    badge: "./favicon-32.png",
    tag: data.tag || "openclaw-notification",
    data: { url: data.url || "./" },
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  const targetUrl = event.notification.data?.url || "./";

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      // Focus an existing window if one is open.
      for (const client of clients) {
        if (new URL(client.url).pathname === new URL(targetUrl, self.location.origin).pathname) {
          return client.focus();
        }
      }
      return self.clients.openWindow(targetUrl);
    }),
  );
});
