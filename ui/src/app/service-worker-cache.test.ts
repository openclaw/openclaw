// Control UI tests cover service worker cache behavior.
import { createHash, webcrypto } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const serviceWorkerPath = path.join(here, "../../public/sw.js");

describe("Control UI service worker HTTP recovery", () => {
  it("restores only the current generic shell for an explicitly offline chat navigation", async () => {
    const worker = createFetchServiceWorker(undefined, { online: false });
    worker.cache.set(
      `${worker.scope}__offline_shell__`,
      new Response("current generic shell", { headers: { "Content-Type": "text/html" } }),
    );
    expect(
      await (
        await worker.dispatch({ url: `${worker.scope}chat/main/session`, mode: "navigate" })
      )?.text(),
    ).toBe("current generic shell");
    expect(worker.fetch).not.toHaveBeenCalled();
  });
  it("never stores or replays a no-store liveness probe", async () => {
    const worker = createFetchServiceWorker("https://control.example/");
    const request = { url: `${worker.scope}healthz`, cache: "no-store" as const };
    worker.cache.set(request.url, Response.json({ ok: true, status: "live" }));
    worker.fetch.mockResolvedValueOnce(Response.json({ ok: true, status: "live" }));

    expect(await (await worker.dispatch(request))?.json()).toEqual({ ok: true, status: "live" });
    expect(worker.cachePut).not.toHaveBeenCalled();
    worker.fetch.mockRejectedValueOnce(new TypeError("Offline"));
    expect((await worker.dispatch(request))?.type).toBe("error");
    expect(worker.cacheMatch).not.toHaveBeenCalled();
  });

  it.each(["/", "/openclaw/"])(
    "keeps dynamic responses out of the cache beneath %s",
    async (basePath) => {
      for (const route of [
        "__openclaw__/assistant-media",
        "api/chat/media/outgoing/image",
        "rpc",
        "plugins/example/data",
        "avatar/main",
      ]) {
        const worker = createFetchServiceWorker(`https://control.example${basePath}`);
        const url = `${worker.scope}${route}?mediaTicket=synthetic-ticket`;
        worker.cache.set(url, new Response("cached private response"));
        worker.fetch.mockResolvedValueOnce(new Response("fresh private response"));

        const fresh = await worker.dispatch({ url });

        expect(await fresh?.text()).toBe("fresh private response");
        expect(worker.cacheMatch).not.toHaveBeenCalled();
        expect(worker.cachePut).not.toHaveBeenCalled();

        worker.fetch.mockRejectedValueOnce(new TypeError("Failed to fetch"));
        const failed = await worker.dispatch({ url });

        expect(failed?.type).toBe("error");
        expect(worker.cacheMatch).not.toHaveBeenCalled();
        expect(worker.windowClients[0].postMessage).toHaveBeenCalledExactlyOnceWith(
          { type: "openclaw-http-request-failed" },
          [],
        );
        expect(worker.windowClients[1].postMessage).not.toHaveBeenCalled();
      }
    },
  );

  it("reports an unauthorized response without exposing the request URL", async () => {
    const worker = createFetchServiceWorker();
    const response = new Response("Sign in", { status: 401 });
    worker.fetch.mockResolvedValueOnce(response);

    const result = await worker.dispatch({
      url: `${worker.scope}custom-theme.css?token=synthetic-secret`,
    });

    expect(result).toBe(response);
    expect(worker.cachePut).not.toHaveBeenCalled();
    expect(worker.windowClients[0].postMessage).toHaveBeenCalledExactlyOnceWith(
      { type: "openclaw-http-request-failed" },
      [],
    );
    expect(worker.windowClients[1].postMessage).not.toHaveBeenCalled();
  });

  it("does not cache a redirected response as an application resource", async () => {
    const worker = createFetchServiceWorker();
    const response = new Response("Sign in");
    Object.defineProperty(response, "redirected", { value: true });
    worker.fetch.mockResolvedValueOnce(response);

    expect(await worker.dispatch({ url: `${worker.scope}assets/app-AbCd1234.js` })).toBe(response);
    expect(worker.cachePut).not.toHaveBeenCalled();
    expect(worker.windowClients[0].postMessage).not.toHaveBeenCalled();
  });

  it.each([
    "assets/app-AbCd1234.js",
    "assets/background-AbCd1234.webp",
    "fonts/custom.woff2?v=public-fixture",
  ])(
    "preserves cached %s and returns a network error when no offline copy exists",
    async (route) => {
      const worker = createFetchServiceWorker();
      const url = `${worker.scope}${route}`;
      worker.fetch
        .mockResolvedValueOnce(new Response("offline asset"))
        .mockRejectedValue(new TypeError("Offline"));

      expect(await (await worker.dispatch({ url }))?.text()).toBe("offline asset");
      expect(await (await worker.dispatch({ url }))?.text()).toBe("offline asset");
      expect(worker.windowClients[0].postMessage).not.toHaveBeenCalled();

      worker.cache.clear();
      expect((await worker.dispatch({ url }))?.type).toBe("error");
    },
  );

  it("preserves ordinary HTTP errors for their request owner without requesting sign-in", async () => {
    const worker = createFetchServiceWorker();
    const response = new Response("Not found", { status: 404 });
    worker.fetch.mockResolvedValueOnce(response);

    expect(await worker.dispatch({ url: `${worker.scope}missing.css` })).toBe(response);
    expect(worker.windowClients[0].postMessage).not.toHaveBeenCalled();
    expect(worker.cachePut).not.toHaveBeenCalled();
  });

  it.each([
    { method: "HEAD" },
    { method: "POST" },
    { mode: "navigate" as const },
    { url: "https://outside.example/openclaw/image.png" },
    { url: "https://control.example/openclaw-other/image.png" },
  ])("leaves out-of-contract requests to the browser: %j", async (request) => {
    const worker = createFetchServiceWorker();

    expect(await worker.dispatch(request)).toBeUndefined();
    expect(worker.fetch).not.toHaveBeenCalled();
    expect(worker.cacheMatch).not.toHaveBeenCalled();
    expect(worker.getClient).not.toHaveBeenCalled();
  });

  it.each([
    { clientId: "" },
    { clientId: "closed-window" },
    { clientUrl: "https://outside.example/openclaw/chat" },
    { clientUrl: "https://control.example/openclaw-other/chat" },
    { clientType: "worker" },
  ])("does not notify an unrelated or absent window: %j", async (options) => {
    const worker = createFetchServiceWorker(undefined, options);
    worker.fetch.mockRejectedValueOnce(new TypeError("Failed to fetch"));

    expect((await worker.dispatch({ clientId: options.clientId }))?.type).toBe("error");
    expect(worker.windowClients[0].postMessage).not.toHaveBeenCalled();
    expect(worker.windowClients[1].postMessage).not.toHaveBeenCalled();
  });
});

describe("Control UI offline app shell", () => {
  it("bounds stalled preparation, preserves completed assets, and resumes on a later probe", async () => {
    vi.useFakeTimers();
    try {
      const worker = createFetchServiceWorker();
      worker.fetch
        .mockImplementationOnce(
          (_url, options) =>
            new Promise((_resolve, reject) => {
              options?.signal?.addEventListener(
                "abort",
                () => reject(new DOMException("Preparation timed out", "AbortError")),
                { once: true },
              );
            }),
        )
        .mockResolvedValueOnce(new Response("build asset"));
      let installed = false;
      const install = worker.install().then(() => {
        installed = true;
      });
      await vi.advanceTimersByTimeAsync(59_999);
      expect(installed).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(installed).toBe(true);
      await install;
      expect(worker.skipWaiting).toHaveBeenCalledOnce();
      expect(worker.cache.has(worker.scope + "__offline_shell__")).toBe(false);
      expect(worker.cache.has(worker.scope + offlineBootFixture.assets[1].path)).toBe(true);
      worker.fetch.mockResolvedValue(new Response("build asset"));
      await worker.probe();
      expect(worker.cache.has(worker.scope + "__offline_shell__")).toBe(true);
      expect(worker.fetch).toHaveBeenCalledTimes(3);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
  it("prepares exact build assets through the signed-in same-origin proxy session", async () => {
    const worker = createFetchServiceWorker();
    worker.fetch.mockImplementation(async (_url, options) =>
      options?.credentials === "same-origin"
        ? new Response("build asset", { headers: { "Content-Type": "application/javascript" } })
        : new Response("Sign in", {
            status: 401,
            headers: { "WWW-Authenticate": "Basic realm=Control" },
          }),
    );
    await worker.install();
    expect(worker.cache.has(worker.scope + "__offline_shell__")).toBe(true);
    for (const asset of offlineBootFixture.assets) {
      expect(worker.fetch).toHaveBeenCalledWith(worker.scope + asset.path, {
        credentials: "same-origin",
        redirect: "error",
        integrity: asset.integrity,
        signal: expect.any(AbortSignal),
      });
    }
    worker.setOnline(false);
    expect(
      await (await worker.dispatch({ url: worker.scope + "chat", mode: "navigate" }))?.text(),
    ).toContain("generic shell");
  });
  it("finishes a partial install on coalesced online probes without redownloading completed assets", async () => {
    const worker = createFetchServiceWorker();
    const shellUrl = worker.scope + "__offline_shell__";
    worker.fetch
      .mockResolvedValueOnce(new Response("build asset"))
      .mockRejectedValueOnce(new TypeError("packet loss"));
    await worker.install();
    expect(worker.cache.has(shellUrl)).toBe(false);
    expect(worker.cache.has(worker.scope + offlineBootFixture.assets[0].path)).toBe(true);
    expect(worker.skipWaiting).toHaveBeenCalledOnce();

    worker.setOnline(false);
    await worker.probe();
    expect(worker.fetch).toHaveBeenCalledTimes(2);
    expect(worker.cache.has(shellUrl)).toBe(false);

    const started = createDeferred();
    const resumed = createDeferred<Response>();
    worker.fetch.mockImplementationOnce(() => {
      started.resolve();
      return resumed.promise;
    });
    worker.setOnline(true);
    const firstProbe = worker.probe();
    const secondProbe = worker.probe();
    expect(worker.probeReply).toHaveBeenCalledTimes(3);
    expect(worker.probeReply).toHaveBeenLastCalledWith({ type: "sw-updated", version: "dev" });
    // A pre-fix worker never starts the request: fail at its missing event
    // lifetime instead of leaving the regression waiting on a real timeout.
    expect(worker.waitUntil).toHaveBeenCalledTimes(4);
    expect(worker.waitUntil.mock.calls[2]?.[0]).toBe(worker.waitUntil.mock.calls[3]?.[0]);
    await started.promise;
    expect(worker.fetch.mock.calls.slice(2)).toEqual([
      [
        worker.scope + offlineBootFixture.assets[1].path,
        {
          credentials: "same-origin",
          redirect: "error",
          integrity: offlineBootFixture.assets[1].integrity,
          signal: expect.any(AbortSignal),
        },
      ],
    ]);
    expect(worker.cache.has(shellUrl)).toBe(false);
    resumed.resolve(new Response("build asset"));
    await Promise.all([firstProbe, secondProbe]);
    expect(worker.cache.has(shellUrl)).toBe(true);

    const writes = worker.cachePut.mock.calls.length;
    await worker.probe();
    expect(worker.fetch).toHaveBeenCalledTimes(3);
    expect(worker.cachePut).toHaveBeenCalledTimes(writes);
    worker.setOnline(false);
    expect(
      await (await worker.dispatch({ url: worker.scope + "chat", mode: "navigate" }))?.text(),
    ).toContain("generic shell");
  });

  it("does not begin installation preparation while explicitly offline, then prepares on an online probe", async () => {
    const worker = createFetchServiceWorker(undefined, { online: false });
    await worker.install();
    await worker.probe();
    expect(worker.fetch).not.toHaveBeenCalled();
    expect(worker.cacheMatch).not.toHaveBeenCalled();
    expect(worker.cachePut).not.toHaveBeenCalled();
    expect(worker.skipWaiting).toHaveBeenCalledOnce();
    worker.setOnline(true);
    worker.fetch.mockImplementation(async () => new Response("build asset"));
    await worker.probe();
    expect(worker.cache.has(worker.scope + "__offline_shell__")).toBe(true);
  });

  it.each(["wrong bytes", "private response"])(
    "refetches %s from the current cache instead of trusting an old build",
    async (invalid) => {
      const worker = createFetchServiceWorker();
      const url = worker.scope + offlineBootFixture.assets[0].path;
      worker.cache.set(
        url,
        new Response(invalid === "wrong bytes" ? "corrupt" : "build asset", {
          headers: invalid === "private response" ? { "Cache-Control": "private" } : {},
        }),
      );
      worker.priorCache.set(url, new Response("build asset"));
      worker.priorCache.set(worker.scope + "__offline_shell__", new Response("old shell"));
      worker.fetch.mockImplementation(async () => new Response("build asset"));
      await worker.probe();
      expect(worker.fetch).toHaveBeenCalledTimes(offlineBootFixture.assets.length);
      for (const asset of offlineBootFixture.assets) {
        expect(worker.fetch).toHaveBeenCalledWith(worker.scope + asset.path, {
          credentials: "same-origin",
          redirect: "error",
          integrity: asset.integrity,
          signal: expect.any(AbortSignal),
        });
      }
      expect(await worker.cache.get(worker.scope + "__offline_shell__")?.text()).toContain(
        "generic shell",
      );
    },
  );

  it.each([
    "https://control.example/",
    "https://control.example/openclaw/",
    "https://control.example/openclaw",
  ])("warms build assets before control and serves generic routes beneath %s", async (scope) => {
    const worker = createFetchServiceWorker(scope);
    worker.fetch.mockImplementation(async () => new Response("build asset"));
    await worker.install();
    worker.setOnline(false);
    const base = scope.endsWith("/") ? scope : scope + "/";
    expect(worker.fetch.mock.calls).toEqual(
      offlineBootFixture.assets.map((asset) => [
        base + asset.path,
        {
          credentials: "same-origin",
          redirect: "error",
          integrity: asset.integrity,
          signal: expect.any(AbortSignal),
        },
      ]),
    );
    expect(worker.waitUntil).toHaveBeenCalledOnce();
    expect(worker.cachePut).toHaveBeenCalledBefore(worker.skipWaiting);
    for (const route of ["", "chat", "chat/main/session?token=synthetic", "new", "new/"]) {
      const response = await worker.dispatch({ url: base + route, mode: "navigate" });
      expect(response?.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
      expect(await response?.text()).toContain(
        `src="${new URL(base).pathname}assets/app-AbCd1234.js"`,
      );
      expect(response?.headers.get("Content-Security-Policy")).toBe(offlineBootFixture.csp);
    }
    expect([...worker.cache.keys()]).toEqual([
      base + "__offline_assets__",
      ...offlineBootFixture.assets.map((asset) => base + asset.path),
      base + "__offline_shell__",
    ]);
  });

  it("does not substitute an old shell but still serves its exact hashed assets", async () => {
    const worker = createFetchServiceWorker(undefined, { online: false });
    worker.priorCache.set(worker.scope + "__offline_shell__", new Response("old shell"));
    worker.priorCache.set(worker.scope + "assets/old-AbCd1234.js", new Response("old asset"));
    expect((await worker.dispatch({ url: worker.scope + "chat", mode: "navigate" }))?.type).toBe(
      "error",
    );
    expect(
      await (await worker.dispatch({ url: worker.scope + "assets/old-AbCd1234.js" }))?.text(),
    ).toBe("old asset");
    expect(worker.fetch).not.toHaveBeenCalled();
  });

  it("leaves online navigation entirely native, including login redirects and HTTP challenges", async () => {
    const worker = createFetchServiceWorker(undefined, { online: true });
    worker.cache.set(worker.scope + "__offline_shell__", new Response("shell"));
    worker.fetch.mockResolvedValue(
      new Response("Sign in", {
        status: 401,
        headers: { "WWW-Authenticate": 'Basic realm="synthetic"' },
      }),
    );
    for (const route of ["", "chat", "new", "login"]) {
      expect(
        await worker.dispatch({ url: worker.scope + route, mode: "navigate" }),
      ).toBeUndefined();
    }
    expect(worker.fetch).not.toHaveBeenCalled();
    expect(worker.cacheMatch).not.toHaveBeenCalled();
  });

  it("never navigates to the shell for non-app routes even when explicitly offline", async () => {
    const worker = createFetchServiceWorker(undefined, { online: false });
    worker.cache.set(worker.scope + "__offline_shell__", new Response("shell"));
    for (const route of [
      "api/chat",
      "__openclaw__/assistant-media",
      "plugins/example/chat",
      "assets/app-AbCd1234.js",
      "avatar/main",
      "rpc",
      "login",
      "settings",
      "new/other",
      "chatty",
    ]) {
      expect(
        await worker.dispatch({ url: worker.scope + route, mode: "navigate" }),
      ).toBeUndefined();
    }
    expect(worker.cacheMatch).not.toHaveBeenCalled();
  });

  it.each<ResponseInit>([
    { status: 401 },
    { status: 200, headers: { "Content-Type": "text/html" } },
    { status: 200, headers: { "Cache-Control": "private, max-age=100" } },
    { status: 200, headers: { "Cache-Control": "public, no-store" } },
    { status: 200, headers: { Vary: "Origin, Cookie" } },
    { status: 200, headers: { "WWW-Authenticate": 'Basic realm="synthetic"' } },
  ])("does not publish an incomplete or login-contaminated shell: %j", async (init) => {
    const worker = createFetchServiceWorker();
    worker.fetch
      .mockResolvedValueOnce(new Response("rejected asset", init))
      .mockResolvedValueOnce(new Response("valid asset"));
    await worker.install();
    expect(worker.cache.has(worker.scope + "__offline_shell__")).toBe(false);
    expect(worker.cache.has(worker.scope + offlineBootFixture.assets[0].path)).toBe(false);
    expect(worker.cache.has(worker.scope + offlineBootFixture.assets[1].path)).toBe(true);
    expect(worker.skipWaiting).toHaveBeenCalledOnce();
  });

  it("does not cache credential-bearing, arbitrary, or unversioned HTTP reads", async () => {
    const worker = createFetchServiceWorker();
    worker.fetch.mockImplementation(async () => new Response("uncached response"));
    for (const route of [
      "",
      "chat",
      "custom-theme.css",
      "fonts/custom.woff2",
      "assets/app-AbCd1234.js?token=synthetic",
      "fonts/custom.woff2?v=other-build&token=synthetic",
    ]) {
      await worker.dispatch({ url: worker.scope + route });
    }
    await worker.dispatch({
      url: worker.scope + "assets/app-AbCd1234.js",
      headers: new Headers({ Authorization: "Bearer synthetic" }),
    });
    expect(worker.cachePut).not.toHaveBeenCalled();
    expect(worker.cacheMatch).not.toHaveBeenCalled();
  });

  it("uses the same public URL key for install fetches and module requests with Origin", async () => {
    const worker = createFetchServiceWorker();
    worker.fetch.mockImplementation(
      async () => new Response("asset", { headers: { Vary: "Origin" } }),
    );
    await worker.install();
    const url = worker.scope + "assets/app-AbCd1234.js";
    const response = await worker.dispatch({
      url,
      headers: new Headers({ Origin: "https://control.example" }),
    });
    expect(await response?.text()).toBe("asset");
    expect(worker.cacheMatch).toHaveBeenCalledWith(url, {
      cacheName: "openclaw-control-dev-fixture",
    });
    expect(worker.fetch).toHaveBeenCalledTimes(offlineBootFixture.assets.length);
  });

  it("admits an old public asset only from its retained build inventory", async () => {
    const worker = createFetchServiceWorker();
    const priorUrl = worker.scope + "fonts/old-only.woff2?v=previous-build";
    worker.priorCache.set(
      worker.scope + "__offline_assets__",
      Response.json({
        version: "previous-build",
        assets: ["fonts/old-only.woff2"],
      }),
    );
    worker.priorCache.set(priorUrl, new Response("previous font"));
    worker.fetch.mockRejectedValue(new TypeError("Offline"));
    expect(await (await worker.dispatch({ url: priorUrl }))?.text()).toBe("previous font");
    expect(
      (await worker.dispatch({ url: priorUrl.replace("previous-build", "unknown-build") }))?.type,
    ).toBe("error");
    expect(
      (await worker.dispatch({ url: priorUrl.replace("old-only", "unknown-asset") }))?.type,
    ).toBe("error");
    expect(worker.cachePut).not.toHaveBeenCalled();
  });

  it("preserves network delivery when Cache Storage is unavailable", async () => {
    const worker = createFetchServiceWorker();
    worker.cacheMatch.mockRejectedValueOnce(new Error("storage denied"));
    worker.fetch.mockResolvedValueOnce(new Response("asset"));
    expect(
      await (await worker.dispatch({ url: worker.scope + "assets/app-AbCd1234.js" }))?.text(),
    ).toBe("asset");
    expect(worker.fetch).toHaveBeenCalledOnce();
  });

  it("extends the fetch event through cache writes but storage failure does not break a response", async () => {
    const worker = createFetchServiceWorker();
    worker.fetch.mockResolvedValueOnce(new Response("asset"));
    worker.cachePut.mockRejectedValueOnce(new Error("quota"));
    expect(
      await (await worker.dispatch({ url: worker.scope + "assets/app-AbCd1234.js" }))?.text(),
    ).toBe("asset");
    expect(worker.waitUntil).toHaveBeenCalledOnce();
  });
});

type ServiceWorkerFetchRequest = Pick<Request, "url" | "method" | "mode" | "cache" | "headers">;
type CacheRequest = string | ServiceWorkerFetchRequest;
const offlineBootFixture = {
  id: "fixture",
  html: '<!doctype html><html><head><script src="./assets/app-AbCd1234.js"></script></head><body>generic shell</body></html>',
  csp: "default-src 'self'; base-uri 'none'",
  assets: [
    {
      path: "assets/app-AbCd1234.js",
      integrity: "sha256-" + createHash("sha256").update("build asset").digest("base64"),
    },
    {
      path: "assets/chat-AbCd1234.css",
      integrity: "sha256-" + createHash("sha256").update("build asset").digest("base64"),
    },
  ] as const,
  publicAssetVersion: "public-fixture",
  publicAssets: ["fonts/custom.woff2"],
};
type ServiceWorkerFetchEventStub = {
  request: ServiceWorkerFetchRequest;
  clientId: string;
  respondWith(promise: Promise<Response | undefined>): void;
  waitUntil(promise: Promise<unknown>): void;
  data?: { type: string };
  ports?: Array<{ postMessage(message: unknown): void }>;
};

function createFetchServiceWorker(
  scope = "https://control.example/openclaw/",
  options: { clientUrl?: string; clientType?: string; online?: boolean } = {},
) {
  const listeners = new Map<string, (event: ServiceWorkerFetchEventStub) => void>();
  const cache = new Map<string, Response>();
  const priorCache = new Map<string, Response>();
  const cacheMatch = vi.fn(async (request: CacheRequest, matchOptions?: { cacheName: string }) =>
    (matchOptions?.cacheName === "openclaw-control-old" ? priorCache : cache)
      .get(typeof request === "string" ? request : request.url)
      ?.clone(),
  );
  const cachePut = vi.fn(async (request: CacheRequest, response: Response) => {
    cache.set(typeof request === "string" ? request : request.url, response);
  });
  const fetch = vi.fn<(request: CacheRequest, options?: RequestInit) => Promise<Response>>();
  const skipWaiting = vi.fn(async () => undefined);
  const navigator = { onLine: options.online ?? true };
  const probeReply = vi.fn();
  const pendingWrites: Promise<unknown>[] = [];
  const waitUntil = vi.fn((pending: Promise<unknown>) => {
    pendingWrites.push(pending);
  });
  const windowClients = [
    {
      id: "requesting-window",
      type: options.clientType ?? "window",
      url: options.clientUrl ?? `${scope}chat`,
      postMessage: vi.fn(),
    },
    { id: "another-window", type: "window", url: `${scope}chat/other`, postMessage: vi.fn() },
  ] as const;
  const getClient = vi.fn(async (id: string) => windowClients.find((client) => client.id === id));
  const source = fs
    .readFileSync(serviceWorkerPath, "utf8")
    .replace(
      "const OFFLINE_BOOT = null;",
      () => `const OFFLINE_BOOT = ${JSON.stringify(offlineBootFixture)};`,
    );
  new vm.Script(source, {
    filename: "ui/public/sw.js",
  }).runInNewContext({
    URL,
    Response,
    crypto: webcrypto,
    btoa,
    AbortController,
    setTimeout,
    clearTimeout,
    caches: {
      match: cacheMatch,
      open: async () => ({ put: cachePut }),
      keys: async () => ["openclaw-control-old", "openclaw-control-dev-fixture"],
    },
    fetch,
    self: {
      addEventListener: (type: string, listener: (event: ServiceWorkerFetchEventStub) => void) =>
        listeners.set(type, listener),
      location: new URL("sw.js", scope),
      registration: { scope },
      navigator,
      skipWaiting,
      clients: { get: getClient },
    },
  });
  return {
    scope,
    cache,
    priorCache,
    cacheMatch,
    cachePut,
    fetch,
    windowClients,
    getClient,
    skipWaiting,
    waitUntil,
    probeReply,
    setOnline(online: boolean) {
      navigator.onLine = online;
    },
    probe() {
      const start = pendingWrites.length;
      listeners.get("message")?.({
        data: { type: "sw-version-probe" },
        ports: [{ postMessage: probeReply }],
        request: {
          url: scope,
          method: "GET",
          mode: "cors",
          cache: "default",
          headers: new Headers(),
        },
        clientId: "requesting-window",
        respondWith: vi.fn(),
        waitUntil,
      });
      return Promise.all(pendingWrites.slice(start));
    },
    async install() {
      listeners.get("install")?.({
        waitUntil,
        request: {
          url: scope,
          method: "GET",
          mode: "cors",
          cache: "default",
          headers: new Headers(),
        },
        clientId: "",
        respondWith: vi.fn(),
      });
      await Promise.all(pendingWrites);
    },
    async dispatch(
      requestOptions: Partial<ServiceWorkerFetchRequest> & { clientId?: string } = {},
    ) {
      let completion: Promise<Response | undefined> | undefined;
      listeners.get("fetch")?.({
        request: {
          url:
            requestOptions.url ??
            `${scope}__openclaw__/assistant-media?source=media://inbound/image`,
          method: requestOptions.method ?? "GET",
          mode: requestOptions.mode ?? "cors",
          cache: requestOptions.cache ?? "default",
          headers: requestOptions.headers ?? new Headers(),
        },
        clientId: requestOptions.clientId ?? "requesting-window",
        respondWith(pending) {
          completion = pending;
        },
        waitUntil,
      });
      const result = await completion;
      await Promise.all(pendingWrites);
      return result;
    },
  };
}
