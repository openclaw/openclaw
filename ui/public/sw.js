const CACHE_PREFIX = "openclaw-control-";
const EMBEDDED_CACHE_VERSION = "__OPENCLAW_CONTROL_UI_BUILD_ID__";
const URL_CACHE_VERSION = new URL(self.location.href).searchParams
  .get("v")
  ?.replace(/[^a-zA-Z0-9._-]/g, "-");
const CACHE_VERSION =
  (EMBEDDED_CACHE_VERSION !== "__OPENCLAW_CONTROL_UI_BUILD_ID__"
    ? EMBEDDED_CACHE_VERSION
    : URL_CACHE_VERSION) || "dev";
const CACHE_NAME = `${CACHE_PREFIX}${CACHE_VERSION}`;
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
  }
});

const PRECACHE_URLS = ["./"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS)));
  self.skipWaiting();
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
    if (cacheable && response.ok && !response.redirected) {
      const clone = response.clone();
      void caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
    }
    return response;
  } catch {
    await reportControlUiHttpFailure(event);
    const cached = cacheable ? await caches.match(event.request) : undefined;
    return cached || Response.error();
  }
}

self.addEventListener("fetch", (event) => {
  // Only the requesting app owns recovery. Other origins and scoped apps keep
  // their own network and cache policies, even when this worker controls the tab.
  if (event.request.method !== "GET") {
    return;
  }
  const pathname = controlUiPathname(new URL(event.request.url));
  if (pathname === null) {
    return;
  }

  // Skip top-level navigations so the browser can handle HTTP auth
  // challenges natively — WWW-Authenticate dialogs are bypassed when the
  // response comes from a service worker, breaking reverse-proxy setups
  // with basic/digest auth in front of the gateway.
  if (event.request.mode === "navigate") {
    return;
  }

  // Dynamic reads must reach their authority owner, including after an edge
  // login expires. Never replay previously cached metadata or media tickets.
  const cacheable = !(
    pathname.startsWith("/__openclaw__/") ||
    pathname.startsWith("/api/") ||
    pathname.startsWith("/rpc") ||
    pathname.startsWith("/plugins/") ||
    pathname.startsWith("/avatar/")
  );

  // Cache-first for hashed assets; network-first for other paths. Versioned
  // public URLs reuse the HTTP immutable cache; unversioned/custom files revalidate.
  if (cacheable && pathname.includes("/assets/")) {
    event.respondWith(
      caches.match(event.request).then((cached) => cached || fetchControlUiRequest(event, true)),
    );
  } else {
    event.respondWith(fetchControlUiRequest(event, cacheable));
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
        // Focus and navigation can reject after a window is matched;
        // keep both recovery paths on the validated app scope.
        if (!hasExplicitTarget) {
          return client.focus().catch(() => self.clients.openWindow(targetUrl.href));
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

      return targetClient
        .navigate(targetUrl.href)
        .then((navigatedClient) => (navigatedClient ?? targetClient).focus())
        .catch(() => self.clients.openWindow(targetUrl.href));
    }),
  );
});
