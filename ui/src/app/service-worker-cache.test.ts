// @vitest-environment node
// Control UI tests cover service worker cache behavior.
import { createHash, webcrypto } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
// Explicit package entry: Bun maps the bare "undici" import to Bun.fetch.
import { fetch as fetchWithIntegrity } from "undici/index.js";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const serviceWorkerPath = path.join(here, "../../public/sw.js");

describe("Control UI service worker HTTP recovery", () => {
  it("never stores or replays private, unversioned, or no-store HTTP reads", async () => {
    const reads: Array<{
      scope?: string;
      route: string;
      cache?: RequestCache;
      headers?: Headers;
      liveProbe?: boolean;
    }> = [
      { scope: "https://control.example/", route: "healthz", cache: "no-store", liveProbe: true },
      ...["/", "/openclaw/"].flatMap((basePath) =>
        [
          "__openclaw__/assistant-media",
          "api/chat/media/outgoing/image",
          "rpc",
          "plugins/example/data",
          "avatar/main",
        ].map((route) => ({
          scope: `https://control.example${basePath}`,
          route: `${route}?mediaTicket=synthetic-ticket`,
        })),
      ),
      ...[
        "",
        "chat",
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
    for (const { scope, route, cache, headers, liveProbe } of reads) {
      const worker = createFetchServiceWorker(scope);
      const request = { url: `${worker.scope}${route}`, cache, headers };
      const payload = { ok: true, status: "live" };
      worker.cache.set(
        request.url,
        liveProbe ? Response.json(payload) : new Response("cached private response"),
      );
      worker.fetch.mockResolvedValueOnce(
        liveProbe ? Response.json(payload) : new Response("fresh private response"),
      );
      const fresh = await worker.dispatch(request);
      if (liveProbe) {
        expect(await fresh?.json()).toEqual(payload);
      } else {
        expect(await fresh?.text()).toBe("fresh private response");
      }
      expect(worker.cacheMatch).not.toHaveBeenCalled();
      expect(worker.cachePut).not.toHaveBeenCalled();
      worker.fetch.mockRejectedValueOnce(new TypeError("Failed to fetch"));
      expect((await worker.dispatch(request))?.type).toBe("error");
      expect(worker.cacheMatch).not.toHaveBeenCalled();
      expect(worker.windowClients[0].postMessage).toHaveBeenCalledExactlyOnceWith(
        { type: "openclaw-http-request-failed" },
        [],
      );
      expect(worker.windowClients[1].postMessage).not.toHaveBeenCalled();
    }
  });

  it("does not report expected reachability-probe failures to browser auth recovery", async () => {
    const worker = createFetchServiceWorker("https://control.example/");
    const request = {
      url: worker.scope + "healthz",
      cache: "no-store" as const,
      headers: new Headers({ "X-OpenClaw-Reachability-Probe": "1" }),
    };
    worker.fetch.mockRejectedValueOnce(new TypeError("offline"));
    expect((await worker.dispatch(request))?.type).toBe("error");
    worker.fetch.mockResolvedValueOnce(new Response("Sign in", { status: 401 }));
    expect((await worker.dispatch(request))?.status).toBe(401);
    expect(worker.windowClients[0].postMessage).not.toHaveBeenCalled();
    expect(worker.cachePut).not.toHaveBeenCalled();
  });

  it("serves prior public-asset versions only from complete previous caches without storing new responses", async () => {
    const worker = createFetchServiceWorker();
    const url = worker.scope + "fonts/custom.woff2?v=previous-build";
    worker.cache.set(url, new Response("wrong generation"));
    worker.fetch.mockResolvedValueOnce(new Response("network asset"));
    expect(await (await worker.dispatch({ url }))?.text()).toBe("network asset");
    expect(worker.cachePut).not.toHaveBeenCalled();
    worker.priorCache.set(worker.scope + "__offline_shell__", new Response("previous shell"));
    worker.priorCache.set(url, new Response("previous font"));
    worker.fetch.mockRejectedValue(new TypeError("offline"));
    expect(await (await worker.dispatch({ url }))?.text()).toBe("previous font");
    expect(worker.fetch).toHaveBeenCalledOnce();
  });

  it.each([
    { status: 401, route: "custom-theme.css?token=synthetic-secret", redirected: false },
    { status: 200, route: "assets/app-AbCd1234.js", redirected: true },
  ])(
    "returns $status/redirected=$redirected without caching or disclosing the URL",
    async ({ status, route, redirected }) => {
      const worker = createFetchServiceWorker();
      const response = new Response("Sign in", { status });
      if (redirected) {
        Object.defineProperty(response, "redirected", { value: true });
      }
      worker.fetch.mockResolvedValueOnce(response);
      expect(await worker.dispatch({ url: worker.scope + route })).toBe(response);
      expect(worker.cachePut).not.toHaveBeenCalled();
      if (status === 401) {
        expect(worker.windowClients[0].postMessage).toHaveBeenCalledExactlyOnceWith(
          { type: "openclaw-http-request-failed" },
          [],
        );
      } else {
        expect(worker.windowClients[0].postMessage).not.toHaveBeenCalled();
      }
      expect(worker.windowClients[1].postMessage).not.toHaveBeenCalled();
    },
  );

  it.each(["assets/app-AbCd1234.js", "fonts/custom.woff2?v=public-fixture"])(
    "serves %s without a second network request and fails offline without a copy",
    async (route) => {
      const worker = createFetchServiceWorker();
      const url = `${worker.scope}${route}`;
      worker.fetch
        .mockResolvedValueOnce(new Response("offline asset"))
        .mockRejectedValue(new TypeError("Offline"));

      expect(await (await worker.dispatch({ url }))?.text()).toBe("offline asset");
      expect(await (await worker.dispatch({ url }))?.text()).toBe("offline asset");
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
        "api/chat",
        "healthz",
        "approve/request",
        "ask/request",
        "focus/session",
        "__openclaw__/assistant-media",
        "__openclaw__/download/file",
        "plugins/example/chat",
        "plugins/example",
        "assets/app-AbCd1234.js",
        "avatar/main",
        "rpc",
        "login",
        "new/other",
        "chatty",
      ].map((route) => ({ url: `https://control.example/openclaw/${route}`, mode: "navigate" })),
    },
  ])("leaves $name to the browser", async ({ online, requests }) => {
    const worker = createFetchServiceWorker(undefined, { online });
    worker.cache.set(worker.scope + "__offline_shell__", new Response("shell"));
    worker.fetch.mockResolvedValue(
      new Response("Sign in", {
        status: 401,
        headers: { "WWW-Authenticate": 'Basic realm="synthetic"' },
      }),
    );
    for (const request of requests) {
      expect(await worker.dispatch(request)).toBeUndefined();
    }
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
  it("prepares untouched lazy modules only after the shell and idle, with four downloads at most", async () => {
    vi.useFakeTimers();
    try {
      const worker = createFetchServiceWorker();
      worker.fetch.mockImplementation(async () => new Response("build asset"));
      await worker.install();
      expect(worker.fetch).toHaveBeenCalledTimes(offlineBootFixture.assets.length);
      const downloads: Array<ReturnType<typeof createDeferred<Response>>> = [];
      worker.fetch.mockImplementation(() => {
        expect(worker.cache.has(worker.scope + "__offline_shell__")).toBe(true);
        const download = createDeferred<Response>();
        downloads.push(download);
        return download.promise;
      });
      const preparation = worker.probe({ saveData: false });
      await vi.advanceTimersByTimeAsync(999);
      expect(downloads).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(downloads).toHaveLength(4);
      for (const download of downloads) {
        download.resolve(new Response("build asset"));
      }
      worker.fetch.mockImplementation(async () => new Response("build asset"));
      await vi.runAllTimersAsync();
      await preparation;
      worker.setOnline(false);
      worker.fetch.mockRejectedValue(new TypeError("offline"));
      for (const asset of offlineBootFixture.deferredAssets) {
        expect(await (await worker.dispatch({ url: worker.scope + asset.path }))?.text()).toBe(
          "build asset",
        );
      }
      expect(worker.fetch).toHaveBeenCalledTimes(
        offlineBootFixture.assets.length + offlineBootFixture.deferredAssets.length,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([{ saveData: true }, { effectiveType: "slow-2g" }, { effectiveType: "2g" }])(
    "records an intentional deferred skip for %j without changing boot preparation",
    async (network) => {
      const worker = createFetchServiceWorker();
      worker.fetch.mockImplementation(async () => new Response("build asset"));
      await worker.probe(network);
      expect(worker.cache.has(worker.scope + "__offline_shell__")).toBe(true);
      expect(worker.fetch).toHaveBeenCalledTimes(offlineBootFixture.assets.length);
      expect(worker.info).toHaveBeenCalledWith(
        expect.stringContaining("skipped"),
        network.saveData ? "save-data" : "slow-connection",
      );
    },
  );

  it("does not download deferred assets without a complete shell", async () => {
    const worker = createFetchServiceWorker();
    worker.fetch.mockRejectedValue(new TypeError("offline"));
    await worker.probe({ saveData: false });
    expect(worker.cache.has(worker.scope + "__offline_shell__")).toBe(false);
    expect(worker.fetch.mock.calls.map(([url]) => url)).toEqual(
      offlineBootFixture.assets.map((asset) => worker.scope + asset.path),
    );
  });

  it("aborts active downloads when Save-Data is enabled and resumes when it is disabled", async () => {
    vi.useFakeTimers();
    try {
      const worker = createFetchServiceWorker();
      worker.fetch.mockImplementation(async () => new Response("build asset"));
      await worker.install();
      const signals: AbortSignal[] = [];
      worker.fetch.mockImplementation(
        (_url, options) =>
          new Promise((_resolve, reject) => {
            signals.push(options!.signal!);
            options!.signal!.addEventListener("abort", () => reject(new Error("aborted")), {
              once: true,
            });
          }),
      );
      const preparation = worker.probe({ saveData: false });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(signals).toHaveLength(4);
      await worker.probe({ saveData: true });
      await preparation;
      expect(signals.every((signal) => signal.aborted)).toBe(true);
      worker.fetch.mockImplementation(async () => new Response("build asset"));
      const resumed = worker.probe({ saveData: false });
      await vi.runAllTimersAsync();
      await resumed;
      for (const asset of offlineBootFixture.deferredAssets) {
        expect(worker.cache.has(worker.scope + asset.path)).toBe(true);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("aborts background downloads for foreground requests and resumes after they settle", async () => {
    vi.useFakeTimers();
    try {
      const worker = createFetchServiceWorker();
      worker.fetch.mockImplementation(async () => new Response("build asset"));
      await worker.install();
      const signals: AbortSignal[] = [];
      worker.fetch.mockImplementation(
        (_url, options) =>
          new Promise((_resolve, reject) => {
            signals.push(options!.signal!);
            options!.signal!.addEventListener("abort", () => reject(new Error("aborted")), {
              once: true,
            });
          }),
      );
      const preparation = worker.probe({ saveData: false });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(signals).toHaveLength(4);
      const foreground = createDeferred<Response>();
      worker.fetch.mockImplementationOnce(() => foreground.promise);
      const request = worker.dispatch();
      expect(signals.every((signal) => signal.aborted)).toBe(true);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(signals).toHaveLength(4);
      foreground.resolve(new Response("foreground"));
      expect(await (await request)?.text()).toBe("foreground");
      worker.fetch.mockImplementation(async () => new Response("build asset"));
      await vi.advanceTimersByTimeAsync(999);
      expect(worker.cache.has(worker.scope + offlineBootFixture.deferredAssets[0]!.path)).toBe(
        false,
      );
      await vi.runAllTimersAsync();
      await preparation;
      for (const asset of offlineBootFixture.deferredAssets) {
        expect(worker.cache.has(worker.scope + asset.path)).toBe(true);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("retires obsolete caches and announces updates when chunk promotion exceeds quota", async () => {
    const worker = createFetchServiceWorker();
    const asset = offlineBootFixture.deferredAssets[0]!;
    worker.priorCache.set(worker.scope + "__offline_shell__", new Response("previous shell"));
    worker.olderCache.set(worker.scope + asset.path, new Response("build asset"));
    worker.cachePut.mockRejectedValue(new DOMException("Cache full", "QuotaExceededError"));

    await worker.activate();

    expect(worker.cacheDelete.mock.calls).toEqual([["openclaw-control-older"]]);
    expect(worker.priorCache.has(worker.scope + "__offline_shell__")).toBe(true);
    expect(worker.cache.has(worker.scope + asset.path)).toBe(false);
    for (const client of worker.windowClients) {
      expect(client.postMessage).toHaveBeenCalledExactlyOnceWith(
        { type: "sw-updated", version: "dev" },
        [],
      );
    }
  });

  it("preserves verified unchanged chunks before retiring old versions, then skips them on resume", async () => {
    vi.useFakeTimers();
    try {
      const worker = createFetchServiceWorker();
      const [reused, corrupt, ...remaining] = offlineBootFixture.deferredAssets;
      worker.olderCache.set(worker.scope + reused!.path, new Response("build asset"));
      worker.olderCache.set(worker.scope + corrupt!.path, new Response("corrupt"));
      worker.priorCache.set(worker.scope + "__offline_shell__", new Response("previous shell"));
      worker.fetch.mockImplementation(async () => new Response("build asset"));
      await worker.install();
      await worker.activate();
      expect(worker.cacheDelete).toHaveBeenCalledWith("openclaw-control-older");
      expect(
        await worker.cache
          .get(worker.scope + reused!.path)
          ?.clone()
          .text(),
      ).toBe("build asset");
      expect(worker.cache.has(worker.scope + corrupt!.path)).toBe(false);
      for (const asset of remaining) {
        worker.cache.set(worker.scope + asset.path, new Response("build asset"));
      }
      worker.fetch.mockClear();
      // Exercise fetch's SRI contract on fixed bytes without opening a port.
      worker.fetch.mockImplementation(async (_url, options) => {
        const response = await fetchWithIntegrity("data:text/javascript,corrupt", {
          integrity: options?.integrity,
        });
        return new Response(await response.arrayBuffer());
      });
      const rejected = worker.probe({ saveData: false });
      await vi.runAllTimersAsync();
      await rejected;
      expect(worker.cache.has(worker.scope + corrupt!.path)).toBe(false);
      expect(worker.fetch).toHaveBeenCalledExactlyOnceWith(
        worker.scope + corrupt!.path,
        expect.objectContaining({ integrity: corrupt!.integrity, priority: "low" }),
      );
      worker.fetch.mockImplementation(async () => new Response("build asset"));
      const resumed = worker.probe({ saveData: false });
      await vi.runAllTimersAsync();
      await resumed;
      expect(worker.cache.has(worker.scope + corrupt!.path)).toBe(true);
      expect(worker.fetch).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

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
    worker.fetch.mockRejectedValue(new TypeError("Offline"));
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
    "replaces %s in the current cache with integrity-matched bytes from an old build",
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
      expect(worker.fetch).toHaveBeenCalledTimes(offlineBootFixture.assets.length - 1);
      for (const asset of offlineBootFixture.assets.slice(1)) {
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
      const response = await worker.dispatch({ url: base + route, mode: "navigate" });
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

  it("uses the previous complete shell and its chunks while the new build is incomplete", async () => {
    const worker = createFetchServiceWorker(undefined, { online: false });
    worker.priorCache.set(worker.scope + "__offline_shell__", new Response("old shell"));
    worker.priorCache.set(worker.scope + "assets/old-AbCd1234.js", new Response("old asset"));
    worker.fetch.mockRejectedValue(new TypeError("Offline"));
    expect(
      await (await worker.dispatch({ url: worker.scope + "chat", mode: "navigate" }))?.text(),
    ).toBe("old shell");
    expect(
      await (await worker.dispatch({ url: worker.scope + "assets/old-AbCd1234.js" }))?.text(),
    ).toBe("old asset");
    expect(worker.fetch).toHaveBeenCalledOnce();
  });

  it("falls back on a network failure while online, but preserves authentication responses", async () => {
    const worker = createFetchServiceWorker();
    worker.cache.set(worker.scope + "__offline_shell__", new Response("shell"));
    worker.fetch.mockRejectedValueOnce(new TypeError("VPN unavailable"));
    expect(
      await (
        await worker.dispatch({ url: worker.scope + "settings/connection", mode: "navigate" })
      )?.text(),
    ).toBe("shell");
    worker.fetch.mockResolvedValueOnce(
      new Response("Sign in", { status: 401, headers: { "WWW-Authenticate": "Basic" } }),
    );
    const denied = await worker.dispatch({
      url: worker.scope + "settings?view=compact",
      mode: "navigate",
    });
    expect(denied?.status).toBe(302);
    const nativeUrl = denied?.headers.get("Location");
    expect(nativeUrl).toBe(worker.scope + "settings?view=compact&openclaw_http_auth=1");
    expect(await worker.dispatch({ url: nativeUrl!, mode: "navigate" })).toBeUndefined();
    expect(worker.fetch).toHaveBeenCalledTimes(2);
    worker.fetch.mockResolvedValueOnce(new Response("Forbidden", { status: 403 }));
    const forbidden = await worker.dispatch({ url: worker.scope + "settings", mode: "navigate" });
    expect(forbidden?.status).toBe(403);
    expect(await forbidden?.text()).toBe("Forbidden");
  });

  it.each([500, 502, 503, 504])(
    "uses the cached shell for an online %i navigation, or preserves the server error without a shell",
    async (status) => {
      const worker = createFetchServiceWorker();
      const request = { url: worker.scope + "settings/connection", mode: "navigate" as const };
      const unavailable = new Response("Gateway unavailable", {
        status,
        headers: { "Content-Type": "text/html", "Retry-After": "10" },
      });
      worker.fetch.mockResolvedValue(unavailable);
      expect(await worker.dispatch(request)).toBe(unavailable);

      worker.cache.set(worker.scope + "__offline_shell__", new Response("shell"));
      const recovered = await worker.dispatch(request);
      expect(recovered?.status).toBe(200);
      expect(await recovered?.text()).toBe("shell");
      worker.cacheMatch.mockRejectedValueOnce(new Error("storage denied"));
      expect(await worker.dispatch(request)).toBe(unavailable);
      expect(worker.fetch).toHaveBeenCalledTimes(3);
      expect(worker.cachePut).not.toHaveBeenCalled();
    },
  );

  it("keeps a complete previous generation on failed preparation, then retires only older generations", async () => {
    const worker = createFetchServiceWorker();
    worker.priorCache.set(worker.scope + "__offline_shell__", new Response("previous shell"));
    worker.fetch.mockRejectedValue(new TypeError("offline"));
    await worker.install();
    await worker.activate();
    expect(worker.cacheDelete.mock.calls).toEqual([["openclaw-control-older"]]);
    expect(worker.priorCache.has(worker.scope + "__offline_shell__")).toBe(true);
    worker.fetch.mockResolvedValue(new Response("build asset"));
    await worker.probe();
    expect(worker.cacheDelete.mock.calls).toEqual([["openclaw-control-older"]]);
    expect(worker.priorCache.has(worker.scope + "__offline_shell__")).toBe(true);
  });

  it("preserves an installing replacement cache when the active worker is probed", async () => {
    const worker = createFetchServiceWorker();
    worker.fetch.mockResolvedValue(new Response("build asset"));
    await worker.install();
    await worker.activate();
    const replacementName = "openclaw-control-next-fixture";
    const replacementCache = new Map([
      [worker.scope + "assets/next.js", new Response("installing replacement")],
    ]);
    worker.generations.set(replacementName, replacementCache);

    await worker.probe();

    expect(worker.generations.get(replacementName)).toBe(replacementCache);
    expect(worker.cache.has(worker.scope + "__offline_shell__")).toBe(true);
  });

  it("uses the cached shell when an online navigation stalls until the deadline", async () => {
    vi.useFakeTimers();
    try {
      const worker = createFetchServiceWorker();
      worker.cache.set(worker.scope + "__offline_shell__", new Response("shell"));
      worker.fetch.mockImplementation(
        (_request, options) =>
          new Promise((_resolve, reject) => {
            options?.signal?.addEventListener(
              "abort",
              () => reject(new DOMException("timeout", "AbortError")),
              { once: true },
            );
          }),
      );
      const pending = worker.dispatch({
        url: worker.scope + "settings/connection",
        mode: "navigate",
      });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(await (await pending)?.text()).toBe("shell");
      expect(worker.fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
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

  it.each(["cacheMatch", "cachePut"] as const)(
    "preserves delivery and the fetch lifetime when %s fails",
    async (operation) => {
      const worker = createFetchServiceWorker();
      worker.fetch.mockResolvedValueOnce(new Response("asset"));
      worker[operation].mockRejectedValueOnce(new Error("storage denied"));
      expect(
        await (await worker.dispatch({ url: worker.scope + "assets/app-AbCd1234.js" }))?.text(),
      ).toBe("asset");
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
  deferredAssets: [
    "session-actions",
    "session-organizer-operations.runtime",
    "rename",
    "reactions",
    "drafts",
  ].map((name) => ({
    path: `assets/${name}-AbCd1234.js`,
    integrity: "sha256-" + createHash("sha256").update("build asset").digest("base64"),
  })),
  publicAssetVersion: "public-fixture",
  publicAssets: ["fonts/custom.woff2", "themes/custom.css", "manifest.webmanifest"],
};
type ServiceWorkerFetchEventStub = {
  request: ServiceWorkerFetchRequest;
  clientId: string;
  respondWith(promise: Promise<Response | undefined>): void;
  waitUntil(promise: Promise<unknown>): void;
  data?: { type: string; offlinePrecache?: { saveData?: boolean; effectiveType?: string } };
  ports?: Array<{ postMessage(message: unknown): void }>;
};

function createFetchServiceWorker(
  scope = "https://control.example/openclaw/",
  options: { clientUrl?: string; clientType?: string; online?: boolean } = {},
) {
  const listeners = new Map<string, (event: ServiceWorkerFetchEventStub) => void>();
  const cache = new Map<string, Response>();
  const priorCache = new Map<string, Response>();
  const olderCache = new Map<string, Response>();
  const generations = new Map([
    ["openclaw-control-older", olderCache],
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
  const info = vi.fn();
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
    console: { info },
    Date,
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
      clients: {
        get: getClient,
        claim: async () => undefined,
        matchAll: async () => windowClients,
      },
    },
  });
  const createLifecycleRequest = (): ServiceWorkerFetchRequest => ({
    url: scope,
    method: "GET",
    mode: "cors",
    cache: "default",
    headers: new Headers(),
  });
  return {
    scope,
    cache,
    priorCache,
    olderCache,
    generations,
    info,
    cacheDelete,
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
    async activate() {
      listeners.get("activate")?.({
        waitUntil,
        request: createLifecycleRequest(),
        clientId: "",
        respondWith: vi.fn(),
      });
      await Promise.all(pendingWrites);
    },
    probe(offlinePrecache?: { saveData?: boolean; effectiveType?: string }) {
      const start = pendingWrites.length;
      listeners.get("message")?.({
        data: { type: "sw-version-probe", offlinePrecache },
        ports: [{ postMessage: probeReply }],
        request: createLifecycleRequest(),
        clientId: "requesting-window",
        respondWith: vi.fn(),
        waitUntil,
      });
      return Promise.all(pendingWrites.slice(start));
    },
    async install() {
      listeners.get("install")?.({
        waitUntil,
        request: createLifecycleRequest(),
        clientId: "",
        respondWith: vi.fn(),
      });
      await Promise.all(pendingWrites);
    },
    async dispatch(
      requestOptions: Partial<ServiceWorkerFetchRequest> & { clientId?: string } = {},
    ) {
      const start = pendingWrites.length;
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
      await Promise.all(pendingWrites.slice(start));
      return result;
    },
  };
}
