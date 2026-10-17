import { createHash, webcrypto } from "node:crypto";
import fs from "node:fs";
import vm from "node:vm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";

const failedRequest = { type: "openclaw-http-request-failed" };
const makeResponse = (body = "build asset", init?: ResponseInit) => new Response(body, init);
let worker: ReturnType<typeof createFetchServiceWorker>;
beforeEach(() => {
  worker = createFetchServiceWorker();
});
const stalledFetch = (_request: CacheRequest, options?: RequestInit) =>
  new Promise<Response>((_resolve, reject) => {
    options?.signal?.addEventListener(
      "abort",
      () => reject(new DOMException("timeout", "AbortError")),
      { once: true },
    );
  });
const assetOptions = (integrity: string) => ({
  credentials: "same-origin",
  redirect: "error",
  integrity,
  signal: expect.any(AbortSignal),
});
const bootAsset = (assetPath: string) => ({
  path: assetPath,
  integrity: "sha256-" + createHash("sha256").update("build asset").digest("base64"),
});
function expectNoCalls(...mocks: Array<{ mock: { calls: unknown[] } }>) {
  for (const mock of mocks) {
    expect(mock.mock.calls).toEqual([]);
  }
}
function expectNotification(source: typeof worker, notified = true) {
  expect(source.windowClients.map((client) => client.postMessage.mock.calls)).toEqual([
    notified ? [[failedRequest, []]] : [],
    [],
  ]);
}
const withFakeTimers = async (run: () => Promise<void>) => {
  vi.useFakeTimers();
  try {
    await run();
  } finally {
    vi.useRealTimers();
  }
};

describe("Control UI service worker HTTP recovery", () => {
  it("never stores or replays private, unversioned, or no-store HTTP reads", async () => {
    const reads: Array<Partial<ServiceWorkerFetchRequest> & { scope?: string; route: string }> = [
      { scope: "https://control.example/", route: "healthz", cache: "no-store" },
      ...["/", "/openclaw/"].flatMap((basePath) =>
        ["__openclaw__/assistant-media", "api/chat/media/outgoing/image"].map((route) => ({
          scope: `https://control.example${basePath}`,
          route: `${route}?mediaTicket=synthetic-ticket`,
        })),
      ),
      ...[
        "",
        "chat",
        "rpc",
        "plugins/example/data",
        "avatar/main",
        "custom-theme.css",
        "fonts/custom.woff2",
        "assets/app-AbCd1234.js?token=synthetic",
        "fonts/custom.woff2?v=other-build&token=synthetic",
      ].map((route) => ({ route })),
      {
        route: "assets/app-AbCd1234.js",
        headers: new Headers({ Authorization: "Bearer synthetic" }),
      },
    ];
    for (const { scope, route, cache, headers } of reads) {
      worker = createFetchServiceWorker(scope);
      const request = { url: `${worker.scope}${route}`, cache, headers };
      const payload = { ok: true, status: "live" };
      worker.cache.set(request.url, Response.json({ cached: true }));
      worker.fetch.mockResolvedValueOnce(Response.json(payload));
      const fresh = await worker.dispatch(request);
      expect(await fresh?.json()).toEqual(payload);
      expectNoCalls(worker.cacheMatch, worker.cachePut);
      worker.fetch.mockRejectedValueOnce(new TypeError("Failed to fetch"));
      expect((await worker.dispatch(request))?.type).toBe("error");
      expect(worker.cacheMatch).not.toHaveBeenCalled();
      expectNotification(worker);
    }
  });

  it("reads prior public assets only from complete caches and never writes them", async () => {
    const url = worker.scope + "fonts/custom.woff2?v=previous-build";
    worker.put(url, "wrong generation");
    worker.fetch.mockResolvedValueOnce(makeResponse("network asset"));
    expect(await worker.text(url)).toBe("network asset");
    expect(worker.cachePut).not.toHaveBeenCalled();
    worker.put("__offline_shell__", "previous shell", true);
    worker.put(url, "previous font", true);
    worker.fetch.mockRejectedValue(new TypeError("offline"));
    expect(await worker.text(url)).toBe("previous font");
    expect(worker.fetch).toHaveBeenCalledOnce();
  });

  it.each([
    { status: 401, route: "custom-theme.css?token=synthetic-secret", redirected: false },
    { status: 200, route: "assets/app-AbCd1234.js", redirected: true },
  ])(
    "returns $status/redirected=$redirected without caching or disclosing the URL",
    async ({ status, route, redirected }) => {
      const response = new Response("Sign in", { status });
      if (redirected) {
        Object.defineProperty(response, "redirected", { value: true });
      }
      worker.fetch.mockResolvedValueOnce(response);
      expect(await worker.dispatch({ url: worker.scope + route })).toBe(response);
      expect(worker.cachePut).not.toHaveBeenCalled();
      expectNotification(worker, status === 401);
    },
  );

  it.each(["assets/app-AbCd1234.js", "fonts/custom.woff2?v=public-fixture"])(
    "serves %s without a second network request and fails offline without a copy",
    async (route) => {
      const url = `${worker.scope}${route}`;
      worker.fetch
        .mockResolvedValueOnce(new Response("offline asset"))
        .mockRejectedValue(new TypeError("Offline"));

      expect(await worker.text(url)).toBe("offline asset");
      expect(await worker.text(url)).toBe("offline asset");
      expect(worker.windowClients[0].postMessage).not.toHaveBeenCalled();
      expect(worker.fetch).toHaveBeenCalledOnce();

      worker.cache.clear();
      expect((await worker.dispatch({ url }))?.type).toBe("error");
    },
  );

  it.each<{ name: string; online: boolean; requests: Partial<ServiceWorkerFetchRequest>[] }>([
    {
      name: "foreign scopes and out-of-contract request types",
      online: true,
      requests: [
        { method: "HEAD" },
        { method: "POST" },
        { mode: "navigate" },
        { url: "https://outside.example/openclaw/image.png" },
        { url: "https://control.example/openclaw-other/image.png" },
      ],
    },
    {
      name: "offline navigation outside app routes",
      online: false,
      requests: [
        "__openclaw__/assistant-media",
        "plugins/example/chat",
        "plugins/example",
        "assets/app-AbCd1234.js",
        "new/other",
        "chatty",
      ].map((route) => ({ url: `https://control.example/openclaw/${route}`, mode: "navigate" })),
    },
  ])("leaves $name to the browser", async ({ online, requests }) => {
    worker = createFetchServiceWorker(undefined, { online });
    worker.put("__offline_shell__", "shell");
    worker.fetch.mockResolvedValue(makeResponse("Sign in", { status: 401 }));
    for (const request of requests) {
      expect(await worker.dispatch(request)).toBeUndefined();
    }
    expectNoCalls(worker.fetch, worker.cacheMatch, worker.getClient);
  });

  it.each([
    { clientId: "" },
    { clientId: "closed-window" },
    { clientUrl: "https://outside.example/openclaw/chat" },
    { clientUrl: "https://control.example/openclaw-other/chat" },
    { clientType: "worker" },
  ])("does not notify an unrelated or absent window: %j", async (options) => {
    worker = createFetchServiceWorker(undefined, options);
    worker.fetch.mockRejectedValueOnce(new TypeError("Failed to fetch"));

    expect((await worker.dispatch({ clientId: options.clientId }))?.type).toBe("error");
    expectNoCalls(...worker.windowClients.map((client) => client.postMessage));
  });
});

describe("Control UI offline app shell", () => {
  it("bounds stalled preparation, preserves completed assets, and resumes on a later probe", () =>
    withFakeTimers(async () => {
      worker = createFetchServiceWorker();
      worker.fetch.mockImplementationOnce(stalledFetch).mockResolvedValueOnce(makeResponse());
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
      worker.fetch.mockResolvedValue(makeResponse());
      await worker.probe();
      expect(worker.cache.has(worker.scope + "__offline_shell__")).toBe(true);
      expect(worker.fetch).toHaveBeenCalledTimes(3);
      expect(vi.getTimerCount()).toBe(0);
    }));
  it("coalesces online probes and resumes only incomplete install assets", async () => {
    const shellUrl = worker.scope + "__offline_shell__";
    worker.fetch
      .mockResolvedValueOnce(makeResponse())
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
    expect(worker.waitUntil).toHaveBeenCalledTimes(4);
    expect(worker.waitUntil.mock.calls[2]?.[0]).toBe(worker.waitUntil.mock.calls[3]?.[0]);
    await started.promise;
    expect(worker.fetch.mock.calls.slice(2)).toEqual([
      [
        worker.scope + offlineBootFixture.assets[1].path,
        assetOptions(offlineBootFixture.assets[1].integrity),
      ],
    ]);
    expect(worker.cache.has(shellUrl)).toBe(false);
    resumed.resolve(makeResponse());
    await Promise.all([firstProbe, secondProbe]);
    expect(worker.cache.has(shellUrl)).toBe(true);

    const writes = worker.cachePut.mock.calls.length;
    await worker.probe();
    expect(worker.fetch).toHaveBeenCalledTimes(3);
    expect(worker.cachePut).toHaveBeenCalledTimes(writes);
    worker.setOnline(false);
    worker.fetch.mockRejectedValue(new TypeError("Offline"));
    expect(await worker.text("chat", "navigate")).toContain("generic shell");
  });

  it("defers offline preparation until an online probe", async () => {
    worker = createFetchServiceWorker(undefined, { online: false });
    await worker.install();
    await worker.probe();
    expectNoCalls(worker.fetch, worker.cacheMatch, worker.cachePut);
    expect(worker.skipWaiting).toHaveBeenCalledOnce();
    worker.setOnline(true);
    worker.fetch.mockImplementation(async () => makeResponse());
    await worker.probe();
    expect(worker.cache.has(worker.scope + "__offline_shell__")).toBe(true);
  });

  it.each(["wrong bytes", "private response"])(
    "refetches %s from the current cache instead of trusting an old build",
    async (invalid) => {
      const url = worker.scope + offlineBootFixture.assets[0].path;
      worker.cache.set(
        url,
        new Response(invalid === "wrong bytes" ? "corrupt" : "build asset", {
          headers: invalid === "private response" ? { "Cache-Control": "private" } : {},
        }),
      );
      worker.put(url, "build asset", true);
      worker.put("__offline_shell__", "old shell", true);
      worker.fetch.mockImplementation(async () => makeResponse());
      await worker.probe();
      expect(worker.fetch.mock.calls).toHaveLength(offlineBootFixture.assets.length);
      expect(worker.fetch.mock.calls).toEqual(expect.arrayContaining(worker.assetRequests()));
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
    worker = createFetchServiceWorker(scope);
    worker.fetch.mockImplementation(async (_url, options) =>
      options?.credentials === "same-origin"
        ? new Response("build asset", { headers: { "Content-Type": "application/javascript" } })
        : new Response("Sign in", {
            status: 401,
            headers: { "WWW-Authenticate": "Basic realm=Control" },
          }),
    );
    await worker.install();
    worker.setOnline(false);
    const base = scope.endsWith("/") ? scope : scope + "/";
    expect(worker.fetch.mock.calls).toEqual(worker.assetRequests());
    expect(worker.waitUntil).toHaveBeenCalledOnce();
    expect(worker.cachePut).toHaveBeenCalledBefore(worker.skipWaiting);
    worker.fetch.mockRejectedValue(new TypeError("Offline"));
    const routes = [
      "",
      "index.html",
      "chat",
      "chat/main/session?token=synthetic",
      "new",
      "new/",
      "settings/connection",
      "dashboard/main/session",
      "settings/agents/main/tools",
    ];
    for (const route of routes) {
      const response = await worker.navigate(route);
      expect(response?.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
      const html = await response?.text();
      expect(html).toContain(`src="${new URL(base).pathname}assets/app-AbCd1234.js"`);
      expect(html).toContain("generic shell");
      expect(response?.headers.get("Content-Security-Policy")).toBe(offlineBootFixture.csp);
    }
    expect(worker.fetch).toHaveBeenCalledTimes(offlineBootFixture.assets.length + routes.length);
    expect([...worker.cache.keys()]).toEqual([
      ...offlineBootFixture.assets.map((asset) => base + asset.path),
      base + "__offline_shell__",
    ]);
  });

  it("serves the complete predecessor while the new build is incomplete", async () => {
    worker = createFetchServiceWorker(undefined, { online: false });
    worker.put("__offline_shell__", "old shell", true);
    worker.put("assets/old-AbCd1234.js", "old asset", true);
    worker.fetch.mockRejectedValue(new TypeError("Offline"));
    expect(await worker.text("chat", "navigate")).toBe("old shell");
    expect(await worker.text("assets/old-AbCd1234.js")).toBe("old asset");
    expect(worker.fetch).toHaveBeenCalledOnce();
  });

  it("recovers network failures but preserves authentication and forbidden responses", async () => {
    worker.put("__offline_shell__", "shell");
    worker.fetch.mockRejectedValueOnce(new TypeError("VPN unavailable"));
    expect(await worker.text("settings/connection", "navigate")).toBe("shell");
    worker.fetch.mockResolvedValueOnce(
      new Response("Sign in", { status: 401, headers: { "WWW-Authenticate": "Basic" } }),
    );
    const denied = await worker.navigate("settings?view=compact");
    expect(denied?.status).toBe(302);
    const nativeUrl = denied?.headers.get("Location");
    expect(nativeUrl).toBe(worker.scope + "settings?view=compact&openclaw_http_auth=1");
    expect(await worker.navigate(nativeUrl!)).toBeUndefined();
    expect(worker.fetch).toHaveBeenCalledTimes(2);
    worker.fetch.mockResolvedValueOnce(new Response("Forbidden", { status: 403 }));
    const forbidden = await worker.navigate("settings");
    expect(forbidden?.status).toBe(403);
    expect(await forbidden?.text()).toBe("Forbidden");
  });

  it.each([500, 502, 503, 504])(
    "recovers %i navigations only when a cached shell is readable",
    async (status) => {
      const request = { url: worker.scope + "settings/connection", mode: "navigate" as const };
      const unavailable = makeResponse("Gateway unavailable", { status });
      worker.fetch.mockResolvedValue(unavailable);
      expect(await worker.dispatch(request)).toBe(unavailable);

      worker.put("__offline_shell__", "shell");
      const recovered = await worker.dispatch(request);
      expect(recovered?.status).toBe(200);
      expect(await recovered?.text()).toBe("shell");
      worker.cacheMatch.mockRejectedValueOnce(new Error("storage denied"));
      expect(await worker.dispatch(request)).toBe(unavailable);
      expect(worker.fetch).toHaveBeenCalledTimes(3);
      expect(worker.cachePut).not.toHaveBeenCalled();
    },
  );

  it("retains the complete predecessor across failed and successful preparation", async () => {
    worker.put("__offline_shell__", "previous shell", true);
    worker.fetch.mockRejectedValue(new TypeError("offline"));
    await worker.install();
    await worker.activate();
    expect(worker.cacheDelete.mock.calls).toEqual([["openclaw-control-older"]]);
    expect(worker.priorCache.has(worker.scope + "__offline_shell__")).toBe(true);
    worker.fetch.mockResolvedValue(makeResponse());
    await worker.probe();
    expect(worker.cacheDelete.mock.calls).toEqual([["openclaw-control-older"]]);
    expect(worker.priorCache.has(worker.scope + "__offline_shell__")).toBe(true);
  });

  it("aborts stalled navigation and serves the cached shell at its deadline", () =>
    withFakeTimers(async () => {
      worker = createFetchServiceWorker();
      worker.put("__offline_shell__", "shell");
      worker.fetch.mockImplementation(stalledFetch);
      const pending = worker.navigate("settings/connection");
      await vi.advanceTimersByTimeAsync(10_000);
      expect(await (await pending)?.text()).toBe("shell");
      expect(worker.fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    }));

  it.each<ResponseInit>([
    { status: 401 },
    { headers: { "Content-Type": "text/html" } },
    { headers: { "Cache-Control": "private, max-age=100" } },
    { headers: { "Cache-Control": "public, no-store" } },
    { headers: { Vary: "Origin, Cookie" } },
    { headers: { "WWW-Authenticate": 'Basic realm="synthetic"' } },
  ])("does not publish an incomplete or login-contaminated shell: %j", async (init) => {
    worker.fetch
      .mockResolvedValueOnce(new Response("rejected asset", init))
      .mockResolvedValueOnce(new Response("valid asset"));
    await worker.install();
    expect(worker.cache.has(worker.scope + "__offline_shell__")).toBe(false);
    expect(worker.cache.has(worker.scope + offlineBootFixture.assets[0].path)).toBe(false);
    expect(worker.cache.has(worker.scope + offlineBootFixture.assets[1].path)).toBe(true);
    expect(worker.skipWaiting).toHaveBeenCalledOnce();
  });

  it("shares install URL keys with module requests carrying Origin", async () => {
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

  it.each(["cacheMatch", "cachePut"] as const)(
    "preserves delivery and the fetch lifetime when %s fails",
    async (operation) => {
      worker.fetch.mockResolvedValueOnce(new Response("asset"));
      worker[operation].mockRejectedValueOnce(new Error("storage denied"));
      expect(await worker.text("assets/app-AbCd1234.js")).toBe("asset");
      expect(worker.fetch).toHaveBeenCalledOnce();
      expect(worker.waitUntil).toHaveBeenCalledOnce();
    },
  );
});

type ServiceWorkerFetchRequest = Pick<Request, "url" | "method" | "mode" | "cache" | "headers">;
type CacheRequest = string | ServiceWorkerFetchRequest;
const offlineBootFixture = {
  id: "fixture",
  routes: ["/chat", "/new", "/settings", "/settings/connection"],
  routePrefixes: ["/chat/", "/dashboard/", "/settings/agents/"],
  html: '<!doctype html><html><head><script src="./assets/app-AbCd1234.js"></script></head><body>generic shell</body></html>',
  csp: "default-src 'self'; base-uri 'none'",
  assets: [bootAsset("assets/app-AbCd1234.js"), bootAsset("assets/chat-AbCd1234.css")] as const,
  publicAssetVersion: "public-fixture",
  publicAssets: ["fonts/custom.woff2", "themes/custom.css", "manifest.webmanifest"],
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
  const url = (path: string) => new URL(path, scope.endsWith("/") ? scope : `${scope}/`).href;
  const listeners = new Map<string, (event: ServiceWorkerFetchEventStub) => void>();
  const cache = new Map<string, Response>();
  const priorCache = new Map<string, Response>();
  const generations = new Map([
    ["openclaw-control-older", new Map<string, Response>()],
    ["openclaw-control-old", priorCache],
    ["openclaw-control-dev-fixture", cache],
  ]);
  const cacheDelete = vi.fn(async (name: string) => generations.delete(name));
  const cacheMatch = vi.fn(async (request: CacheRequest, matchOptions?: { cacheName: string }) =>
    generations
      .get(matchOptions?.cacheName ?? "openclaw-control-dev-fixture")
      ?.get(typeof request === "string" ? request : request.url)
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
    .readFileSync(new URL("../../public/sw.js", import.meta.url), "utf8")
    .replace(
      "const OFFLINE_BOOT = null;",
      () => `const OFFLINE_BOOT = ${JSON.stringify(offlineBootFixture)};`,
    );
  const event = (
    overrides: Partial<ServiceWorkerFetchEventStub> = {},
  ): ServiceWorkerFetchEventStub => ({
    request: { url: scope, method: "GET", mode: "cors", cache: "default", headers: new Headers() },
    clientId: "",
    respondWith: vi.fn(),
    waitUntil,
    ...overrides,
  });
  const lifecycle = async (type: string) => {
    listeners.get(type)?.(event());
    await Promise.all(pendingWrites);
  };
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
      keys: async () => [...generations.keys()],
      delete: cacheDelete,
    },
    fetch,
    self: {
      addEventListener: (type: string, listener: (event: ServiceWorkerFetchEventStub) => void) =>
        listeners.set(type, listener),
      location: new URL("sw.js", scope),
      registration: { scope },
      navigator,
      skipWaiting,
      clients: { get: getClient, claim: async () => undefined, matchAll: async () => [] },
    },
  });
  async function dispatch(
    requestOptions: Partial<ServiceWorkerFetchRequest> & { clientId?: string } = {},
  ) {
    let completion: Promise<Response | undefined> | undefined;
    listeners.get("fetch")?.(
      event({
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
      }),
    );
    const result = await completion;
    await Promise.all(pendingWrites);
    return result;
  }
  return {
    scope,
    cache,
    priorCache,
    cacheDelete,
    cacheMatch,
    cachePut,
    fetch,
    windowClients,
    getClient,
    skipWaiting,
    waitUntil,
    probeReply,
    assetRequests: () =>
      offlineBootFixture.assets.map((asset) => [url(asset.path), assetOptions(asset.integrity)]),
    put(path: string, body: string, previous = false) {
      (previous ? priorCache : cache).set(url(path), makeResponse(body));
    },
    setOnline(online: boolean) {
      navigator.onLine = online;
    },
    activate: () => lifecycle("activate"),
    probe() {
      const start = pendingWrites.length;
      listeners.get("message")?.(
        event({
          data: { type: "sw-version-probe" },
          ports: [{ postMessage: probeReply }],
          clientId: "requesting-window",
        }),
      );
      return Promise.all(pendingWrites.slice(start));
    },
    install: () => lifecycle("install"),
    dispatch,
    navigate: (path: string) => dispatch({ url: url(path), mode: "navigate" }),
    text: async (path: string, mode: RequestMode = "cors") =>
      (await dispatch({ url: url(path), mode }))?.text(),
  };
}
