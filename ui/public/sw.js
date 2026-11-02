const CACHE_PREFIX = "openclaw-control-";
const EMBEDDED_CACHE_VERSION = "__OPENCLAW_CONTROL_UI_BUILD_ID__";
const URL_CACHE_VERSION = new URL(self.location.href).searchParams
  .get("v")
  ?.replace(/[^a-zA-Z0-9._-]/g, "-");
const CACHE_VERSION =
  (EMBEDDED_CACHE_VERSION !== "__OPENCLAW_CONTROL_UI_BUILD_ID__"
    ? EMBEDDED_CACHE_VERSION
    : URL_CACHE_VERSION) || "dev";
// Replaced by Vite with generic HTML and integrity-bound boot/deferred inventories.
const OFFLINE_BOOT = null;
const NAVIGATION_TIMEOUT_MS = 10_000;
const NATIVE_AUTH_PARAM = "openclaw_http_auth";
const CACHE_NAME = `${CACHE_PREFIX}${CACHE_VERSION}${OFFLINE_BOOT ? `-${OFFLINE_BOOT.id}` : ""}`;
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
  if (
    event.data?.type === "openclaw-foreground-activity" &&
    event.source?.type === "window" &&
    controlUiPathname(new URL(event.source.url)) !== null
  ) {
    if (event.data.active === true) {
      foregroundClients.add(event.source.id);
      offlineController?.abort();
      deferredController?.abort();
    } else if (foregroundClients.delete(event.source.id)) {
      foregroundSettledAt = Date.now();
    }
  }
  if (event.data?.type === "sw-version-probe") {
    event.ports[0]?.postMessage({ type: "sw-updated", version: CACHE_VERSION });
    if (OFFLINE_BOOT) {
      event.waitUntil(prepareOfflineShell());
      if (event.data.offlinePrecache) {
        const { saveData, effectiveType } = event.data.offlinePrecache;
        const skip = saveData
          ? "save-data"
          : /^(slow-)?2g$/u.test(effectiveType)
            ? "slow-connection"
            : null;
        deferredAllowed = !skip;
        if (skip) {
          deferredController?.abort();
          console.info("OpenClaw deferred offline download skipped:", skip);
        } else {
          event.waitUntil(prepareDeferredAssets());
        }
      }
    }
  }
});

const OFFLINE_SHELL_URL = new URL(`${SCOPE_PATH}__offline_shell__`, SCOPE_URL).href;

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
let offlineController;
function prepareOfflineShell() {
  if (!OFFLINE_BOOT || !self.navigator.onLine) {
    return Promise.resolve();
  }
  // Registration/resume probes share the install work; a failed attempt remains
  // retryable without a retry timer or delaying the build-identity reply.
  // Only activation retires caches: an older worker can still answer probes
  // while its replacement is installing.
  if (!offlinePreparation) {
    offlinePreparation = (async () => {
      const deadline = Date.now() + 60_000;
      while (await waitForForeground(deadline)) {
        const controller = new AbortController();
        offlineController = controller;
        const timeout = setTimeout(() => controller.abort(), deadline - Date.now());
        try {
          await precacheOfflineShell(controller.signal);
        } finally {
          clearTimeout(timeout);
          offlineController = undefined;
        }
        if (!controller.signal.aborted) {
          return;
        }
      }
    })()
      .catch(() => {
        // Cache storage is optional; updates and notifications must still work.
      })
      .finally(() => {
        offlinePreparation = undefined;
      });
  }
  return offlinePreparation;
}

async function completeCacheNames() {
  const names = (await caches.keys()).filter((name) => name.startsWith(CACHE_PREFIX)).toReversed();
  const complete = [];
  for (const name of names) {
    if (await caches.match(OFFLINE_SHELL_URL, { cacheName: name })) {
      complete.push(name);
    }
  }
  return complete;
}

async function retireOldCaches() {
  const complete = await completeCacheNames();
  // Keep one complete predecessor for open documents still importing its chunks.
  // Even an incomplete replacement must retain the last usable shell.
  const previous = complete.find((name) => name !== CACHE_NAME);
  const retired = (await caches.keys()).filter(
    (name) => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME && name !== previous,
  );
  if (OFFLINE_BOOT && retired.length) {
    // Promote unchanged content-addressed files before their only copy disappears.
    // No network work here: installation never waits for deferred downloads.
    try {
      const cache = await caches.open(CACHE_NAME);
      for (const asset of [...OFFLINE_BOOT.assets, ...OFFLINE_BOOT.deferredAssets]) {
        await reuseOfflineAsset(cache, asset, retired);
      }
    } catch {
      // Optional reuse must not block quota recovery or update announcements.
    }
  }
  await Promise.all(retired.map((name) => caches.delete(name)));
}

async function matchOfflineShell(fallback = Response.error()) {
  try {
    const current = await caches.match(OFFLINE_SHELL_URL, { cacheName: CACHE_NAME });
    if (current) {
      return current;
    }
    for (const name of await completeCacheNames()) {
      const response = await caches.match(OFFLINE_SHELL_URL, { cacheName: name });
      if (response) {
        return response;
      }
    }
  } catch {
    // Storage denial must not discard an available Gateway response.
  }
  return fallback;
}

async function isCachedOfflineAsset(response, integrity) {
  if (!response || !cacheableResponse(response)) {
    return false;
  }
  try {
    // Runtime asset writes also enter this cache. Reuse bytes only if they match
    // the inventory, not just a successful response under the expected URL.
    const digest = await crypto.subtle.digest("SHA-256", await response.arrayBuffer());
    return "sha256-" + btoa(String.fromCharCode(...new Uint8Array(digest))) === integrity;
  } catch {
    return false;
  }
}

async function reuseOfflineAsset(cache, asset, previous) {
  const url = new URL(asset.path, new URL(SCOPE_PATH, SCOPE_URL)).href;
  for (const name of [CACHE_NAME, ...previous]) {
    const cached = await caches.match(url, { cacheName: name });
    if (await isCachedOfflineAsset(cached?.clone(), asset.integrity)) {
      if (name !== CACHE_NAME) {
        await cache.put(url, cached);
      }
      return true;
    }
  }
  return false;
}

async function cacheOfflineAsset(cache, asset, signal, previous) {
  try {
    if (await reuseOfflineAsset(cache, asset, previous)) {
      return true;
    }
    if (!self.navigator.onLine || signal.aborted) {
      return false;
    }
    const url = new URL(asset.path, new URL(SCOPE_PATH, SCOPE_URL)).href;
    // Reuse proxy sign-in for static assets, never follow login redirects.
    // Fetch enforces SRI; cache reuse above verifies bytes from cache-on-use too.
    const response = await fetch(url, {
      credentials: "same-origin",
      redirect: "error",
      integrity: asset.integrity,
      signal,
      priority: "low",
    });
    if (!cacheableResponse(response) || signal.aborted) {
      return false;
    }
    await cache.put(url, response);
    return true;
  } catch {
    return false;
  }
}

let deferredAllowed = false;
let deferredPreparation;
let deferredController;
let foregroundRequests = 0;
let foregroundSettledAt = 0;
const foregroundClients = new Set();

async function waitForForeground(deadline, initialQuietUntil = 0) {
  while (Date.now() < deadline) {
    if (foregroundClients.size) {
      // A closed document cannot send its final idle hint, including during installation.
      const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const liveIds = new Set(clients.map((client) => client.id));
      for (const id of foregroundClients) {
        if (!liveIds.has(id)) {
          foregroundClients.delete(id);
          foregroundSettledAt = Date.now();
        }
      }
    }
    const quietMs = Math.max(initialQuietUntil, foregroundSettledAt + 1_000) - Date.now();
    if (!foregroundClients.size && !foregroundRequests && quietMs <= 0) {
      return true;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, Math.min(deadline - Date.now(), Math.max(quietMs, 1_000)));
    });
  }
  return false;
}

function prepareDeferredAssets() {
  if (!deferredPreparation) {
    deferredPreparation = (async () => {
      await prepareOfflineShell();
      if (!(await caches.match(OFFLINE_SHELL_URL, { cacheName: CACHE_NAME }))) {
        return;
      }
      const cache = await caches.open(CACHE_NAME);
      const previous = (await completeCacheNames()).filter((name) => name !== CACHE_NAME);
      const deadline = Date.now() + 60_000;
      const initialQuietUntil = Date.now() + 1_000;
      for (let index = 0; index < OFFLINE_BOOT.deferredAssets.length;) {
        if (!deferredAllowed || !self.navigator.onLine || Date.now() >= deadline) {
          return;
        }
        // Wait for a quiet second after page traffic. Foreground requests abort
        // the batch; verified writes survive and the same batch resumes.
        if (!(await waitForForeground(deadline, initialQuietUntil))) {
          return;
        }
        const controller = new AbortController();
        deferredController = controller;
        const timeout = setTimeout(() => controller.abort(), deadline - Date.now());
        let ready;
        try {
          ready = await Promise.all(
            OFFLINE_BOOT.deferredAssets
              .slice(index, index + 4)
              .map((asset) => cacheOfflineAsset(cache, asset, controller.signal, previous)),
          );
        } finally {
          clearTimeout(timeout);
          deferredController = undefined;
        }
        if (controller.signal.aborted) {
          continue;
        }
        if (!ready.every(Boolean)) {
          return; // A later startup/resume probe retries partial or failed work.
        }
        index += 4;
      }
    })()
      .catch(() => {
        // Optional storage/download failure must not affect boot or page requests.
      })
      .finally(() => {
        deferredPreparation = undefined;
      });
  }
  return deferredPreparation;
}

function respondToControlUiRequest(event, respond) {
  foregroundRequests++;
  offlineController?.abort();
  deferredController?.abort();
  event.respondWith(
    respond().finally(() => {
      foregroundRequests--;
      foregroundSettledAt = Date.now();
    }),
  );
}

async function precacheOfflineShell(signal) {
  if (await caches.match(OFFLINE_SHELL_URL, { cacheName: CACHE_NAME })) {
    return;
  }
  const cache = await caches.open(CACHE_NAME);
  const previous = (await caches.keys()).filter(
    (name) => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME,
  );
  // Bound already-buffered bytes when a foreground operation interrupts installation.
  for (let index = 0; index < OFFLINE_BOOT.assets.length; index += 4) {
    if (signal.aborted) {
      return;
    }
    const ready = await Promise.all(
      OFFLINE_BOOT.assets
        .slice(index, index + 4)
        .map((asset) => cacheOfflineAsset(cache, asset, signal, previous)),
    );
    if (!ready.every(Boolean)) {
      return;
    }
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
      await Promise.all([self.clients.claim(), retireOldCaches()]);
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
  // Reachability owns expected outage failures; they are not failed app reads.
  if (!event.clientId || event.request.headers.get("X-OpenClaw-Reachability-Probe") === "1") {
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

async function matchControlUiAsset(request, currentVersion) {
  try {
    // Writes use public URL-only keys. Match the same key rather than a module
    // request whose Origin header can differ from credential-free install fetches.
    if (currentVersion) {
      const current = await caches.match(request.url, { cacheName: CACHE_NAME });
      if (current && cacheableResponse(current)) {
        return current;
      }
    }
    for (const name of await completeCacheNames()) {
      if (name === CACHE_NAME) {
        continue;
      }
      const cached = await caches.match(request.url, { cacheName: name });
      if (cached && cacheableResponse(cached)) {
        return cached;
      }
    }
  } catch {
    // Storage denial must not prevent ordinary network delivery.
  }
  return undefined;
}

function isVersionedPublicAsset(url, pathname) {
  return (
    OFFLINE_BOOT?.publicAssets.includes(pathname.slice(1)) &&
    url.search === `?v=${encodeURIComponent(OFFLINE_BOOT.publicAssetVersion)}`
  );
}

async function fetchChatNavigation(request, url, signal = request.signal) {
  const entry = new URL(`${SCOPE_PATH}__openclaw__/session-entry`, SCOPE_URL);
  entry.searchParams.set("path", url.pathname + url.search);
  try {
    // Registration is only a navigation hint. The protected route still owns
    // authentication and session access; never follow its denial/login redirects.
    const response = await fetch(entry.href, {
      credentials: "same-origin",
      redirect: "manual",
      cache: "no-store",
      signal,
    });
    if (response.status === 200 && response.headers.get("X-OpenClaw-Session-Entry") === "1") {
      return response;
    }
  } catch {
    // A failed handoff must not prevent a public conversation from opening.
  }
  const response = await fetch(request, { signal });
  // Some proxies also protect /chat. A worker response suppresses native HTTP
  // auth dialogs, so hand those challenges to the unhandled protected navigation.
  return response.status === 401 && response.headers.has("WWW-Authenticate")
    ? Response.redirect(entry.href)
    : response;
}

async function fetchNavigation(request, url, sessionEntry) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), NAVIGATION_TIMEOUT_MS);
  try {
    const response = await (sessionEntry
      ? fetchChatNavigation(request, url, controller.signal)
      : fetch(request, { signal: controller.signal }));
    if (response.status === 401 && response.headers.has("WWW-Authenticate")) {
      // Worker responses suppress native HTTP auth dialogs. Hand the challenge
      // back to an unhandled navigation; the document removes this one-shot hint.
      url.searchParams.set(NATIVE_AUTH_PARAM, "1");
      return Response.redirect(url.href);
    }
    if (response.status >= 500) {
      return matchOfflineShell(response);
    }
    return response;
  } catch {
    // A VPN/proxy failure can reject while the browser still reports online.
    // Never cache a fetched Gateway document or replace an HTTP auth response.
    return matchOfflineShell();
  } finally {
    clearTimeout(timeout);
  }
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
    if (url.searchParams.has(NATIVE_AUTH_PARAM)) {
      return;
    }
    const navigationKeys = url.searchParams.getAll("__openclawSessionKey");
    const composerFocus = url.searchParams.getAll("__openclawComposerFocus");
    const sessionEntry =
      new URL(self.location.href).searchParams.get("session-entry") === "1" &&
      pathname.startsWith("/chat/") &&
      pathname !== "/chat/" &&
      navigationKeys.length <= 1 &&
      navigationKeys.every((key) => {
        if (!key.trim()) {
          return false;
        }
        for (let index = 0; index < key.length; index += 1) {
          const code = key.charCodeAt(index);
          if (code <= 0x1f || code === 0x7f) {
            return false;
          }
        }
        return true;
      }) &&
      composerFocus.length <= 1 &&
      composerFocus.every((value) => value === "1") &&
      [...url.searchParams.keys()].every(
        (key) =>
          key === "dashboard" ||
          key === "draft" ||
          key === "openclaw_mount_recovery" ||
          key === "__openclawSessionFacePreference" ||
          key === "__openclawSessionKey" ||
          key === "__openclawComposerFocus",
      );
    const route = pathname.replace(/\/$/u, "") || "/";
    // Static routes and dedicated dynamic namespaces come from the router.
    // Shared plugin HTTP namespaces and standalone documents stay out.
    if (
      sessionEntry ||
      route === "/" ||
      route === "/index.html" ||
      OFFLINE_BOOT?.routes.includes(route.toLowerCase()) ||
      OFFLINE_BOOT?.routePrefixes.some((prefix) => pathname.startsWith(prefix))
    ) {
      respondToControlUiRequest(event, () => fetchNavigation(event.request, url, sessionEntry));
    }
    return;
  }

  // Cache only immutable build URLs, never arbitrary HTTP reads or credentials.
  // Public asset membership comes from the same build inventory as their version.
  const hashedAsset =
    /^\/assets\/[^/]+-[\w-]{8,}\.(?:js|css|webp|png|svg|woff2)$/u.test(pathname) && !url.search;
  const permitsCache =
    event.request.cache !== "no-store" && !event.request.headers.has("Authorization");

  respondToControlUiRequest(event, async () => {
    const cacheable = permitsCache && (hashedAsset || isVersionedPublicAsset(url, pathname));
    // Prior documents retain versioned fonts/themes too. Only exact cached
    // URLs are reusable; new network writes still require the current version.
    const publicAsset =
      OFFLINE_BOOT?.publicAssets.includes(pathname.slice(1)) && /^\?v=[^&]+$/u.test(url.search);
    const cached =
      permitsCache && (hashedAsset || publicAsset)
        ? await matchControlUiAsset(event.request, cacheable)
        : undefined;
    return cached || fetchControlUiRequest(event, cacheable);
  });
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
    icon:
      typeof data.icon === "string" &&
      data.icon.length <= 2400 &&
      /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(data.icon)
        ? data.icon
        : "./apple-touch-icon.png",
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
