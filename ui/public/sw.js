const CACHE_PREFIX = "openclaw-control-";
const EMBEDDED_CACHE_VERSION = "__OPENCLAW_CONTROL_UI_BUILD_ID__";
const URL_CACHE_VERSION = new URL(self.location.href).searchParams
  .get("v")
  ?.replace(/[^a-zA-Z0-9._-]/g, "-");
const CACHE_VERSION =
  (EMBEDDED_CACHE_VERSION !== "__OPENCLAW_CONTROL_UI_BUILD_ID__"
    ? EMBEDDED_CACHE_VERSION
    : URL_CACHE_VERSION) || "dev";
// Replaced by Vite with generic HTML and its measured, integrity-bound boot graph.
const OFFLINE_BOOT = null;
const CACHE_NAME = `${CACHE_PREFIX}${CACHE_VERSION}${OFFLINE_BOOT ? `-${OFFLINE_BOOT.id}` : ""}`;
const CONTROL_CACHE_LIMIT = 3;
const SCOPE_URL = new URL(self.registration.scope);
const SCOPE_PATH = SCOPE_URL.pathname.endsWith("/") ? SCOPE_URL.pathname : `${SCOPE_URL.pathname}/`;

function controlUiPathname(url) {
  if (url.origin !== SCOPE_URL.origin) {
    return null;
  }
  if (url.pathname === SCOPE_URL.pathname) {
    return "/";
  }
  return url.pathname.startsWith(SCOPE_PATH) ? `/${url.pathname.slice(SCOPE_PATH.length)}` : null;
}

// Older pages reload directly and cannot acquire new config-draft guards. Keep
// their root/chat announcement contract; current pages also reconcile on resume.
function isControlUiChatClient(url) {
  const pathname = controlUiPathname(new URL(url));
  return pathname === "/" || pathname === "/chat" || pathname?.startsWith("/chat/") === true;
}

// A resumed/BFCache document may have missed activation entirely. Build identity
// belongs to the running worker, not its potentially old sw.js?v= registration URL.
self.addEventListener("message", (event) => {
  if (event.data?.type === "sw-version-probe") {
    event.ports[0]?.postMessage({ type: "sw-updated", version: CACHE_VERSION });
    if (OFFLINE_BOOT) {
      event.waitUntil(prepareOfflineShell());
    }
  }
});

const OFFLINE_SHELL_URL = new URL(`${SCOPE_PATH}__offline_shell__`, SCOPE_URL).href;
const PUBLIC_ASSETS_URL = new URL(`${SCOPE_PATH}__offline_assets__`, SCOPE_URL).href;

function cacheableResponse(response) {
  return (
    response.ok &&
    !response.redirected &&
    !/(?:^|,)\s*(?:no-store|private)(?:\s|,|=|$)/i.test(
      response.headers.get("Cache-Control") || "",
    ) &&
    !/(?:^|,)\s*(?:cookie|authorization)\s*(?:,|$)/i.test(response.headers.get("Vary") || "") &&
    !response.headers.has("WWW-Authenticate") &&
    !response.headers.has("Set-Cookie") &&
    !response.headers.get("Content-Type")?.toLowerCase().includes("text/html")
  );
}

let offlinePreparation;
function prepareOfflineShell() {
  if (!OFFLINE_BOOT || !self.navigator.onLine) {
    return Promise.resolve();
  }
  // Registration/resume probes share the install work; a failed attempt remains
  // retryable without a retry timer or delaying the build-identity reply.
  if (!offlinePreparation) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60_000);
    offlinePreparation = precacheOfflineShell(controller.signal)
      .catch(() => {
        // Cache storage is optional; updates and notifications must still work.
      })
      .finally(() => {
        clearTimeout(timeout);
        offlinePreparation = undefined;
      });
  }
  return offlinePreparation;
}

async function isCachedBootAsset(response, integrity) {
  if (!response || !cacheableResponse(response)) {
    return false;
  }
  try {
    // Runtime asset writes also enter this cache. Reuse bytes only if they match
    // the boot graph, not just a successful response under the expected URL.
    const digest = await crypto.subtle.digest("SHA-256", await response.arrayBuffer());
    return "sha256-" + btoa(String.fromCharCode(...new Uint8Array(digest))) === integrity;
  } catch {
    return false;
  }
}

async function precacheOfflineShell(signal) {
  if (await caches.match(OFFLINE_SHELL_URL, { cacheName: CACHE_NAME })) {
    return;
  }
  const cache = await caches.open(CACHE_NAME);
  await cache.put(
    PUBLIC_ASSETS_URL,
    Response.json({
      version: OFFLINE_BOOT.publicAssetVersion,
      assets: OFFLINE_BOOT.publicAssets,
    }),
  );
  const ready = await Promise.all(
    OFFLINE_BOOT.assets.map(async (asset) => {
      try {
        const url = new URL(asset.path, new URL(SCOPE_PATH, SCOPE_URL)).href;
        const cached = await caches.match(url, { cacheName: CACHE_NAME });
        if (await isCachedBootAsset(cached, asset.integrity)) {
          return true;
        }
        if (!self.navigator.onLine) {
          return false;
        }
        // Reuse same-origin proxy sign-in for static assets, never follow a login
        // redirect. Integrity and response policy still admit only exact build bytes.
        const response = await fetch(url, {
          credentials: "same-origin",
          redirect: "error",
          integrity: asset.integrity,
          signal,
        });
        if (!cacheableResponse(response)) {
          return false;
        }
        await cache.put(url, response);
        return true;
      } catch {
        return false;
      }
    }),
  );
  if (!ready.every(Boolean)) {
    return;
  }
  // A deep chat URL must resolve the portable bundle against the registered app
  // root. No fetched document, credential, or route-specific metadata is retained.
  const escapedPath = SCOPE_PATH.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
  const html = OFFLINE_BOOT.html
    .replaceAll('src="./', () => `src="${escapedPath}`)
    .replaceAll('href="./', () => `href="${escapedPath}`)
    .replace(
      "<html",
      () => `<html data-openclaw-control-ui-base-path="${escapedPath.slice(0, -1)}"`,
    );
  await cache.put(
    OFFLINE_SHELL_URL,
    new Response(html, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy": OFFLINE_BOOT.csp,
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
      },
    }),
  );
}

self.addEventListener("install", (event) => {
  event.waitUntil(prepareOfflineShell().then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const cacheKeys = await caches.keys();
      const controlKeys = cacheKeys.filter((key) => key.startsWith(CACHE_PREFIX));
      const priorCacheLimit = Math.max(0, CONTROL_CACHE_LIMIT - 1);
      // Keep a small prior-build window so open tabs can still load old hashed chunks after updates.
      const retained = new Set([
        ...controlKeys.filter((key) => key !== CACHE_NAME).slice(-priorCacheLimit),
        CACHE_NAME,
      ]);

      await Promise.all([
        self.clients.claim(),
        Promise.all(
          controlKeys.filter((key) => !retained.has(key)).map((key) => caches.delete(key)),
        ),
      ]);
      // Queue the announcement without waiting for suspended pages or navigating
      // around their unsaved-work guards. Resumed pages also query our identity.
      const windowClients = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      for (const client of windowClients) {
        if (isControlUiChatClient(client.url)) {
          client.postMessage({ type: "sw-updated", version: CACHE_VERSION }, []);
        }
      }
    })(),
  );
});

async function reportControlUiHttpFailure(event) {
  if (!event.clientId) {
    return;
  }
  try {
    const client = await self.clients.get(event.clientId);
    if (client?.type === "window" && controlUiPathname(new URL(client.url)) !== null) {
      client.postMessage({ type: "openclaw-http-request-failed" }, []);
    }
  } catch {
    // Closing a tab during its request must not replace the HTTP outcome.
  }
}

async function fetchControlUiRequest(event, cacheable) {
  try {
    const response = await fetch(event.request);
    if (response.status === 401) {
      await reportControlUiHttpFailure(event);
    }
    if (cacheable && cacheableResponse(response)) {
      const clone = response.clone();
      event.waitUntil(
        caches
          .open(CACHE_NAME)
          .then((cache) => cache.put(event.request.url, clone))
          .catch(() => {}),
      );
    }
    return response;
  } catch {
    await reportControlUiHttpFailure(event);
    return Response.error();
  }
}

async function matchControlUiAsset(request) {
  try {
    // Writes use public URL-only keys. Match the same key rather than a module
    // request whose Origin header can differ from credential-free install fetches.
    const current = await caches.match(request.url, { cacheName: CACHE_NAME });
    if (current && cacheableResponse(current)) {
      return current;
    }
    // Only hashed/versioned public URLs may reuse the retained prior-build window.
    const keys = await caches.keys();
    for (const cacheName of keys
      .filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME)
      .toReversed()) {
      const cached = await caches.match(request.url, { cacheName });
      if (cached && cacheableResponse(cached)) {
        return cached;
      }
    }
  } catch {
    // Storage denial must not prevent ordinary network delivery.
  }
  return undefined;
}

let priorPublicAssets;
async function isVersionedPublicAsset(url, pathname) {
  if (
    OFFLINE_BOOT?.publicAssets.includes(pathname.slice(1)) &&
    url.search === `?v=${encodeURIComponent(OFFLINE_BOOT.publicAssetVersion)}`
  ) {
    return true;
  }
  if (!url.searchParams.get("v") || url.searchParams.size !== 1) {
    return false;
  }
  // The running build and its retained predecessors are immutable for this
  // worker lifetime. Old tabs with unsaved work may still request their version.
  // An arbitrary ?v= value is not authority to cache a response.
  priorPublicAssets ??= (async () => {
    try {
      const keys = await caches.keys();
      return await Promise.all(
        keys
          .filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME)
          .map(async (cacheName) => {
            try {
              return await (await caches.match(PUBLIC_ASSETS_URL, { cacheName }))?.json();
            } catch {
              return undefined;
            }
          }),
      );
    } catch {
      return [];
    }
  })();
  return (await priorPublicAssets).some(
    (inventory) =>
      typeof inventory?.version === "string" &&
      Array.isArray(inventory.assets) &&
      inventory.assets.includes(pathname.slice(1)) &&
      url.search === `?v=${encodeURIComponent(inventory.version)}`,
  );
}

async function fetchChatNavigation(request, url) {
  const entry = new URL(`${SCOPE_PATH}__openclaw__/session-entry`, SCOPE_URL);
  entry.searchParams.set("path", url.pathname + url.search);
  try {
    // Registration is only a navigation hint. The protected route still owns
    // authentication and session access; never follow its denial/login redirects.
    const response = await fetch(entry.href, {
      credentials: "same-origin",
      redirect: "manual",
      cache: "no-store",
      signal: request.signal,
    });
    if (response.status === 200 && response.headers.get("X-OpenClaw-Session-Entry") === "1") {
      return response;
    }
  } catch {
    // A failed handoff must not prevent a public conversation from opening.
  }
  const response = await fetch(request);
  // Some proxies also protect /chat. A worker response suppresses native HTTP
  // auth dialogs, so hand those challenges to the unhandled protected navigation.
  return response.status === 401 && response.headers.has("WWW-Authenticate")
    ? Response.redirect(entry.href)
    : response;
}

self.addEventListener("fetch", (event) => {
  // Only the requesting app owns recovery. Other origins and scoped apps keep
  // their own network and cache policies, even when this worker controls the tab.
  if (event.request.method !== "GET") {
    return;
  }
  const url = new URL(event.request.url);
  const pathname = controlUiPathname(url);
  if (pathname === null) {
    return;
  }

  if (event.request.mode === "navigate") {
    if (
      self.navigator.onLine &&
      new URL(self.location.href).searchParams.get("session-entry") === "1" &&
      pathname.startsWith("/chat/") &&
      pathname !== "/chat/" &&
      [...url.searchParams.keys()].every(
        (key) => key === "dashboard" || key === "draft" || key === "openclaw_mount_recovery",
      )
    ) {
      event.respondWith(fetchChatNavigation(event.request, url));
    } else if (
      !self.navigator.onLine &&
      (pathname === "/" ||
        pathname === "/new" ||
        pathname === "/new/" ||
        pathname === "/chat" ||
        pathname.startsWith("/chat/"))
    ) {
      event.respondWith(
        caches
          .match(OFFLINE_SHELL_URL, { cacheName: CACHE_NAME })
          .then((cached) => cached || Response.error()),
      );
    }
    return;
  }

  // Cache only immutable build URLs, never arbitrary HTTP reads or credentials.
  // Public asset membership comes from the same build inventory as their version.
  const hashedAsset =
    /^\/assets\/[^/]+-[\w-]{8,}\.(?:js|css|webp|png|svg|woff2)$/u.test(pathname) && !url.search;
  const permitsCache =
    event.request.cache !== "no-store" && !event.request.headers.has("Authorization");

  event.respondWith(
    (async () => {
      const cacheable =
        permitsCache && (hashedAsset || (await isVersionedPublicAsset(url, pathname)));
      const cached = cacheable ? await matchControlUiAsset(event.request) : undefined;
      return cached || fetchControlUiRequest(event, cacheable);
    })(),
  );
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
    renotify: data.renotify === true,
    data: {
      url: data.url || self.registration.scope,
      explicitUrl: Boolean(data.url),
    },
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  // Relative targets belong beneath the registered scope even when its URL
  // omits a trailing slash; keep the exact scope for default navigation.
  const scopeNavigationBase = new URL(SCOPE_PATH, SCOPE_URL);
  const notificationUrl = event.notification.data?.url;
  // Notifications shown before an update stored "./" for implicit targets.
  // Preserve their existing in-scope tabs when the new worker handles the click.
  const hasExplicitTarget =
    event.notification.data?.explicitUrl ?? Boolean(notificationUrl && notificationUrl !== "./");
  let targetUrl = SCOPE_URL;
  try {
    const requestedUrl = new URL(
      (hasExplicitTarget ? notificationUrl : undefined) || SCOPE_URL.href,
      scopeNavigationBase,
    );
    if (controlUiPathname(requestedUrl) !== null) {
      targetUrl = requestedUrl;
    }
  } catch {
    // Malformed notification targets can only fall back to the registered app scope.
  }

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      let targetClient;
      let targetClientRank = -1;
      for (const client of clients) {
        let clientUrl;
        try {
          clientUrl = new URL(client.url);
        } catch {
          continue;
        }

        if (controlUiPathname(clientUrl) === null) {
          continue;
        }
        if (!hasExplicitTarget) {
          return client.focus();
        }

        // Prefer the existing target tab before repurposing another app tab.
        // Client.url can lag SPA history, so its match only chooses a candidate.
        const clientRank =
          clientUrl.href === targetUrl.href
            ? 3
            : clientUrl.pathname === targetUrl.pathname
              ? clientUrl.search === targetUrl.search
                ? 2
                : 1
              : 0;
        if (clientRank > targetClientRank) {
          targetClient = client;
          targetClientRank = clientRank;
          if (clientRank === 3) {
            break;
          }
        }
      }

      if (!targetClient) {
        return self.clients.openWindow(targetUrl.href);
      }

      // Always navigate explicit targets; old or uncontrolled workers can
      // reject navigation, so preserve the validated open-window fallback.
      return targetClient
        .navigate(targetUrl.href)
        .then((navigatedClient) => (navigatedClient ?? targetClient).focus())
        .catch(() => self.clients.openWindow(targetUrl.href));
    }),
  );
});
