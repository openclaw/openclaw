import { toErrorObject as toLintErrorObject } from "@openclaw/normalization-core/error-coercion";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import type { Dispatcher } from "undici";
import { afterEach, describe, expect, it, vi } from "vitest";
import { waitForControlUiDocument } from "../../commands/control-ui-handoff.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { readResponseWithLimit } from "../http-body.js";
import {
  fetchConfiguredLocalOriginWithSsrFGuard,
  fetchWithSsrFGuard,
  type GuardedFetchOptions,
} from "./fetch-guard.js";
import { PinnedDispatcherPool } from "./pinned-dispatcher-pool.js";
import { PROXY_ENV_KEYS } from "./proxy-env.js";
import type { DispatcherAwareRequestInit } from "./runtime-fetch.js";
import {
  ensureGlobalUndiciStreamTimeouts,
  resetGlobalUndiciStreamTimeoutsForTests,
} from "./undici-global-dispatcher.js";

const TEST_UNDICI_RUNTIME_DEPS_KEY = "__OPENCLAW_TEST_UNDICI_RUNTIME_DEPS__";
const { agentCtor, envHttpProxyAgentCtor, proxyAgentCtor, logWarnMock } = vi.hoisted(() => {
  function createMockDispatcher(
    this: { options: unknown; dispatch: Dispatcher["dispatch"] },
    options: unknown,
  ) {
    this.options = options;
    this.dispatch = vi.fn(() => true);
  }
  return {
    agentCtor: vi.fn(createMockDispatcher),
    envHttpProxyAgentCtor: vi.fn(createMockDispatcher),
    proxyAgentCtor: vi.fn(createMockDispatcher),
    logWarnMock: vi.fn(),
  };
});
vi.mock("../../logger.js", async (original) => ({
  ...(await original<typeof import("../../logger.js")>()),
  logWarn: logWarnMock,
}));
vi.mock("node:net", async (original) => ({
  ...(await original<typeof import("node:net")>()),
  getDefaultAutoSelectFamily: () => true,
}));
vi.mock("../wsl.js", () => ({ isWSL2Sync: () => false }));

const publicUrl = "https://public.example/resource";
const localBase = "http://127.0.0.1:11434";
const publicAddress = { address: "93.184.216.34", family: 4 };
const createPublicLookup = () => vi.fn(async () => [publicAddress]);
const lookup = (address: string) =>
  vi.fn(async () => [{ address, family: address.includes(":") ? 6 : 4 }]);
const okResponse = (body = "ok") => new Response(body);
const redirectResponse = (location: string, status = 302) =>
  new Response(null, { status, headers: { location } });
const fetchStub = () => vi.fn(async () => okResponse());

function dispatchAttached(input: RequestInfo | URL, init?: DispatcherAwareRequestInit) {
  if (!init?.dispatcher) {
    throw new Error("expected attached dispatcher");
  }
  const method = init.method ?? "GET";
  if (method !== "GET" && method !== "HEAD") {
    throw new Error("unexpected fixture method");
  }
  const url = new URL(input instanceof Request ? input.url : input.toString());
  init.dispatcher.dispatch({ origin: url.origin, path: url.pathname + url.search, method }, {});
  return okResponse();
}
function expectDispatch(owner: typeof agentCtor, origin: string, path: string, method = "GET") {
  const record = createRequireRecord("record", "expected-record")(owner.mock.instances[0]);
  expect(record.dispatch).toHaveBeenCalledExactlyOnceWith({ origin, path, method }, {});
}
function installRuntime(fetch = fetchStub()) {
  Reflect.set(globalThis, TEST_UNDICI_RUNTIME_DEPS_KEY, {
    Agent: agentCtor,
    EnvHttpProxyAgent: envHttpProxyAgentCtor,
    ProxyAgent: proxyAgentCtor,
    fetch,
  });
}
function clearProxyEnv() {
  for (const key of PROXY_ENV_KEYS) {
    vi.stubEnv(key, "");
  }
}
function managedProxy(mode = "gateway-only") {
  clearProxyEnv();
  vi.stubEnv("OPENCLAW_PROXY_ACTIVE", "1");
  vi.stubEnv("OPENCLAW_PROXY_LOOPBACK_MODE", mode);
  vi.stubEnv("http_proxy", "http://127.0.0.1:7890");
  installRuntime();
}
function guardedRequest(
  fetchImpl: NonNullable<GuardedFetchOptions["fetchImpl"]>,
  options: Partial<GuardedFetchOptions> = {},
) {
  return fetchWithSsrFGuard({
    url: publicUrl,
    lookupFn: createPublicLookup(),
    fetchImpl,
    ...options,
  });
}
function localRequest(
  fetchImpl: NonNullable<GuardedFetchOptions["fetchImpl"]>,
  options: Partial<Parameters<typeof fetchConfiguredLocalOriginWithSsrFGuard>[0]> = {},
) {
  return fetchConfiguredLocalOriginWithSsrFGuard({
    url: `${localBase}/api/embed`,
    configuredLocalOriginBaseUrl: localBase,
    lookupFn: lookup("127.0.0.1"),
    policy: { allowedOrigins: [localBase] },
    fetchImpl,
    ...options,
  });
}
async function raceWithTimeoutResult<T>(
  promise: Promise<T>,
  timeoutMs: number,
  timeoutResult: T,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(timeoutResult), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
function recordedCall<T>(calls: T[], index = 0): T {
  const call = calls[index];
  if (call === undefined) {
    throw new Error(`Missing mock call ${index}`);
  }
  return call;
}
function secondInit(fetchImpl: ReturnType<typeof vi.fn>): RequestInit {
  return recordedCall(fetchImpl.mock.calls, 1)[1];
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  resetGlobalUndiciStreamTimeoutsForTests();
  Reflect.deleteProperty(globalThis, TEST_UNDICI_RUNTIME_DEPS_KEY);
});

describe("guarded fetch policy", () => {
  it.each([
    "http://[ff02::1]/internal",
    "http://0177.0.0.1:8080/internal",
    "http://0x7f000001/internal",
    "http://198.18.0.1:8080/internal",
    "http://user:pass@[::1]:8080/internal",
  ])("blocks noncanonical and special-use IP literal %s before fetch", async (url) => {
    const fetchImpl = fetchStub();
    await expect(fetchWithSsrFGuard({ url, fetchImpl })).rejects.toThrow(
      /private|internal|blocked/i,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("blocks private URLs and redacts their path, query and fragment from audit logs", async () => {
    const fetchImpl = fetchStub();
    await expect(
      fetchWithSsrFGuard({
        url: "http://attacker.com@127.0.0.1:8080/private/secret?token=abc#frag",
        fetchImpl,
        auditContext: "qa-audit",
      }),
    ).rejects.toThrow(/private|internal|blocked/i);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(logWarnMock).toHaveBeenCalledOnce();
    const warning: string = recordedCall(logWarnMock.mock.calls)[0];
    expect(warning).toContain(
      "security: blocked URL fetch (qa-audit) targetOrigin=http://127.0.0.1:8080",
    );
    expect(warning).not.toMatch(/private\/secret|token=abc|#frag|attacker.com/);
  });

  it("blocks IPv6 metadata DNS answers under ULA opt-in", async () => {
    const fetchImpl = fetchStub();
    await expect(
      guardedRequest(fetchImpl, {
        lookupFn: lookup("fd00:ec2::254"),
        policy: { allowIpv6UniqueLocalRange: true },
      }),
    ).rejects.toThrow(/private|internal|blocked/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("fails closed for an HTTP target requiring explicit-proxy DNS pinning", async () => {
    const fetchImpl = fetchStub();
    await expect(
      guardedRequest(fetchImpl, {
        url: "http://public.example/resource",
        dispatcherPolicy: { mode: "explicit-proxy", proxyUrl: "http://127.0.0.1:7890" },
      }),
    ).rejects.toThrow(/explicit proxy ssrf pinning requires https targets/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("does not carry exact-origin trust across a redirect to another private port", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(redirectResponse("http://127.0.0.1:11435/"));
    await expect(
      fetchWithSsrFGuard({
        url: `${localBase}/start`,
        fetchImpl,
        policy: { allowedOrigins: [localBase] },
      }),
    ).rejects.toThrow(/private|internal|blocked/i);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("allows a configured private DNS origin but blocks the same host on another port", async () => {
    const fetchImpl = fetchStub();
    const options = {
      lookupFn: lookup("10.0.0.5"),
      policy: { allowedOrigins: ["http://model.lan:11434"] },
    };
    const result = await guardedRequest(fetchImpl, {
      ...options,
      url: "http://model.lan:11434/v1/models",
    });
    await result.release();
    await expect(
      guardedRequest(fetchImpl, { ...options, url: "http://model.lan:11435/v1/models" }),
    ).rejects.toThrow(/private|internal|blocked/i);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it.each([
    "169.254.169.254",
    "64:ff9b::a9fe:a9fe",
    "64:ff9b:1:808:808:808:a9fe:a9fe",
    "100.100.100.200",
    "::",
  ])("does not promote exact-origin trust into access to %s", async (address) => {
    const fetchImpl = fetchStub();
    await expect(
      guardedRequest(fetchImpl, {
        url: "http://model.lan:11434/v1/models",
        lookupFn: lookup(address),
        policy: { allowedOrigins: ["http://model.lan:11434"] },
      }),
    ).rejects.toThrow(/private|internal|blocked/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("allows a configured IPv6 unique-local exact origin", async () => {
    const fetchImpl = fetchStub();
    const result = await fetchWithSsrFGuard({
      url: "http://[fd00::1]:11434/v1/models",
      fetchImpl,
      policy: { allowedOrigins: ["http://[fd00::1]:11434"] },
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
    await result.release();
  });

  it("allows wildcard subdomains", async () => {
    const fetchImpl = fetchStub();
    const result = await guardedRequest(fetchImpl, {
      url: "https://img.assets.example.com/asset",
      policy: { hostnameAllowlist: ["*.assets.example.com"] },
    });
    expect(result.response.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledOnce();
    await result.release();
  });

  it("fails closed when the runtime rejects the pinned dispatcher", async () => {
    const fetchImpl = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit & { dispatcher?: Dispatcher }) => {
        if (init?.dispatcher) {
          throw Object.assign(new TypeError("fetch failed"), {
            cause: Object.assign(new Error("invalid onRequestStart method"), {
              code: "UND_ERR_INVALID_ARG",
            }),
          });
        }
        return okResponse();
      },
    );
    await expect(guardedRequest(fetchImpl)).rejects.toThrow("fetch failed");
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("ignores dispatcher support markers on explicit ambient fetch", async () => {
    const runtimeFetch = fetchStub();
    const ambient = Object.assign(
      async () => {
        throw new Error("ambient fetch cannot pin DNS");
      },
      { __openclawAcceptsDispatcher: true },
    );
    vi.stubGlobal("fetch", ambient);
    installRuntime(runtimeFetch);
    const result = await guardedRequest(ambient);
    expect(runtimeFetch).toHaveBeenCalledOnce();
    await result.release();
  });

  it("keeps explicit proxy transport policy with DNS pinning disabled", async () => {
    installRuntime();
    const fetchImpl = fetchStub();
    const result = await guardedRequest(fetchImpl, {
      pinDns: false,
      dispatcherPolicy: {
        mode: "explicit-proxy",
        proxyUrl: "http://proxy.example:7890",
        proxyTls: { servername: "public.example" },
      },
    });
    expect(proxyAgentCtor).toHaveBeenCalledWith(
      expect.objectContaining({
        uri: "http://proxy.example:7890",
        proxyTunnel: true,
        allowH2: false,
        requestTls: { servername: "public.example" },
      }),
    );
    expect(fetchImpl).toHaveBeenCalledExactlyOnceWith(
      publicUrl,
      expect.objectContaining({ dispatcher: expect.anything() }),
    );
    await result.release();
  });
});

describe("redirect boundaries", () => {
  it.each([
    [302, "POST", false, false, "GET", undefined],
    [303, "PUT", false, false, "GET", undefined],
    [307, "POST", false, false, "POST", "secret"],
    [308, "POST", true, false, "POST", undefined],
    [307, "POST", true, true, "POST", "secret"],
  ] as const)(
    "rewrites %s %s (cross-origin=%s, replay=%s)",
    async (status, method, crossOrigin, replay, nextMethod, body) => {
      const destination = crossOrigin ? "https://cdn.example/next" : "/next";
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(redirectResponse(destination, status))
        .mockResolvedValueOnce(okResponse());
      const result = await guardedRequest(fetchImpl, {
        allowCrossOriginUnsafeRedirectReplay: replay,
        init: {
          method,
          body: "secret",
          headers: {
            Authorization: "Bearer secret",
            "Content-Type": "application/json",
            "Content-Length": "6",
          },
        },
      });
      const next = secondInit(fetchImpl);
      const headers = new Headers(next.headers);
      expect(next.method).toBe(nextMethod);
      expect(next.body).toBe(body);
      expect(headers.get("authorization")).toBe(crossOrigin ? null : "Bearer secret");
      expect(headers.get("content-type")).toBe(body ? "application/json" : null);
      expect(headers.get("content-length")).toBe(body && !crossOrigin ? "6" : null);
      await result.release();
    },
  );

  it("strips sensitive headers and symbols across origins without mutating caller headers", async () => {
    const headers = {
      Authorization: "Bearer secret",
      Cookie: "session=abc",
      Cookie2: "legacy=1",
      "Proxy-Authorization": "Basic secret",
      "X-Api-Key": "secret",
      "Private-Token": "secret",
      "X-Trace": "1",
      Accept: "application/json",
      "Content-Type": "application/json",
      "User-Agent": "OpenClaw-Test/1.0",
    };
    Object.defineProperty(headers, Symbol("sensitiveHeaders"), {
      value: new Set(["authorization"]),
      enumerable: false,
    });
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(redirectResponse("https://cdn.example/asset"))
      .mockResolvedValueOnce(okResponse());
    const result = await guardedRequest(fetchImpl, { init: { headers } });
    expect(Object.getOwnPropertySymbols(recordedCall(fetchImpl.mock.calls)[1].headers)).toEqual([]);
    expect(Object.getOwnPropertySymbols(headers)).toHaveLength(1);
    expect(Object.fromEntries(new Headers(secondInit(fetchImpl).headers))).toEqual({
      accept: "application/json",
      "content-type": "application/json",
      "user-agent": "OpenClaw-Test/1.0",
    });
    await result.release();
  });

  it("never restores authorization on an HTTPS-to-HTTP downgrade", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(redirectResponse("http://cdn.example/asset"))
      .mockResolvedValueOnce(okResponse());
    const result = await guardedRequest(fetchImpl, {
      init: { headers: { Authorization: "Bearer secret", Accept: "application/json" } },
      retainAuthorizationRedirectHostnameAllowlist: ["cdn.example"],
    });
    const headers = new Headers(secondInit(fetchImpl).headers);
    expect(headers.get("authorization")).toBeNull();
    expect(headers.get("accept")).toBe("application/json");
    await result.release();
  });

  it.each([
    {
      responses: [redirectResponse("http://cdn.example/asset")],
      options: { requireHttps: true },
      error: /must use https/i,
    },
    {
      responses: [redirectResponse("/next"), redirectResponse("/resource")],
      options: {},
      error: /redirect loop/i,
    },
    {
      responses: [redirectResponse("/one"), redirectResponse("/two")],
      options: { maxRedirects: 1 },
      error: /too many redirects/i,
    },
  ])("rejects redirects violating $error", async ({ responses, options, error }) => {
    const fetchImpl = vi.fn();
    for (const response of responses) {
      fetchImpl.mockResolvedValueOnce(response);
    }
    await expect(guardedRequest(fetchImpl, options)).rejects.toThrow(error);
    expect(fetchImpl).toHaveBeenCalledTimes(responses.length);
  });
  it("preserves redirects when response body cancellation rejects", async () => {
    const unhandledRejections: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => {
      unhandledRejections.push(reason);
    };
    const cancel = vi.fn(() => {
      throw new Error("redirect cancellation failed");
    });
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(new ReadableStream<Uint8Array>({ cancel }), {
          status: 302,
          headers: { location: "https://cdn.example.com/asset" },
        }),
      )
      .mockResolvedValueOnce(okResponse("redirected"));
    process.on("unhandledRejection", onUnhandledRejection);
    let result: Awaited<ReturnType<typeof fetchWithSsrFGuard>> | undefined;

    try {
      result = await guardedRequest(fetchImpl, { url: "https://api.example.com/start" });

      expect((await readResponseWithLimit(result.response, 32)).toString("utf8")).toBe(
        "redirected",
      );
      expect(cancel).toHaveBeenCalledOnce();
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(unhandledRejections).toStrictEqual([]);
    } finally {
      await result?.release();
      process.off("unhandledRejection", onUnhandledRejection);
      expect(process.listeners("unhandledRejection")).not.toContain(onUnhandledRejection);
    }
  });

  it.each(["/next", undefined])(
    "settles redirects before retained capture cancellation (location: %s)",
    async (location) => {
      const cancel = vi.fn();
      const response = new Response(new ReadableStream<Uint8Array>({ cancel }), {
        status: 302,
        headers: location ? { location } : {},
      });
      const capture = response.clone();
      const fetchImpl = vi.fn().mockResolvedValueOnce(response).mockResolvedValueOnce(okResponse());
      const request = guardedRequest(fetchImpl, { url: "https://public.example/start" }).then(
        async (result) => {
          try {
            return (await readResponseWithLimit(result.response, 32)).toString("utf8");
          } finally {
            await result.release();
          }
        },
        (error: unknown) => error,
      );

      try {
        const result = await raceWithTimeoutResult(request, 500, undefined);
        if (location) {
          expect(result).toBe("ok");
        } else {
          expect(result).toBeInstanceOf(Error);
          expect(result).toMatchObject({ message: "Redirect missing location header (302)" });
        }
        expect(fetchImpl).toHaveBeenCalledTimes(location ? 2 : 1);
        expect(response.bodyUsed).toBe(true);
        expect(cancel).not.toHaveBeenCalled();
      } finally {
        await capture.body?.cancel();
        await request;
      }
      expect(cancel).toHaveBeenCalledOnce();
    },
  );

  it("rejects timed-out fetches even when dispatcher close stalls", async () => {
    const close = vi.fn(() => new Promise<void>(() => {}));
    const destroy = vi.fn();
    agentCtor.mockImplementationOnce(function MockAgent(this: {
      close: typeof close;
      destroy: typeof destroy;
    }) {
      this.close = close;
      this.destroy = destroy;
    });
    installRuntime();
    const started = createDeferredCore<AbortSignal>();
    const fetchImpl = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (!signal) {
            throw new Error("Expected a request deadline signal");
          }
          signal.addEventListener("abort", () => {
            reject(toLintErrorObject(signal.reason, "Non-Error rejection"));
          });
          started.resolve(signal);
        }),
    );
    vi.useFakeTimers();
    try {
      let outcome: string | undefined;
      const completed = guardedRequest(fetchImpl, { timeoutMs: 1 }).then(
        () => {
          outcome = "resolved";
        },
        (error: unknown) => {
          outcome = error instanceof Error ? error.name : "rejected";
        },
      );
      const signal = await started.promise;

      // Keep the deadline/cleanup ordering independent of event-loop starvation.
      await vi.advanceTimersByTimeAsync(1);
      expect(signal.aborted).toBe(true);
      expect(close).toHaveBeenCalledOnce();
      expect(destroy).not.toHaveBeenCalled();
      expect(outcome).toBeUndefined();

      await vi.advanceTimersByTimeAsync(249);
      expect(destroy).toHaveBeenCalledOnce();
      expect(outcome).toBe("TimeoutError");
      await completed;
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("proxy routing and trust", () => {
  it.each([
    { mode: "strict", active: false, bypass: false, proxy: false },
    { mode: "strict", active: true, bypass: true, proxy: false },
    { mode: "trusted_env_proxy", active: false, bypass: false, proxy: true },
    { mode: "trusted_env_proxy", active: false, bypass: true, proxy: false },
  ] as const)(
    "routes $mode with active=$active and NO_PROXY=$bypass",
    async ({ mode, active, bypass, proxy }) => {
      managedProxy();
      vi.stubEnv("OPENCLAW_PROXY_ACTIVE", active ? "1" : "0");
      if (bypass) {
        vi.stubEnv("NO_PROXY", "public.example");
      }
      const lookupFn = createPublicLookup();
      const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: DispatcherAwareRequestInit) =>
        dispatchAttached(input, init),
      );
      const result = await guardedRequest(fetchImpl, { lookupFn, mode });
      expect(lookupFn).toHaveBeenCalledTimes(proxy ? 0 : 1);
      expect(agentCtor).toHaveBeenCalledTimes(proxy ? 0 : 1);
      expect(proxyAgentCtor).toHaveBeenCalledTimes(proxy ? 1 : 0);
      expect(fetchImpl).toHaveBeenCalledOnce();
      expectDispatch(proxy ? proxyAgentCtor : agentCtor, "https://public.example", "/resource");
      await result.release();
    },
  );

  it("keeps trusted env requests DNS-pinned when only ALL_PROXY is set", async () => {
    clearProxyEnv();
    vi.stubEnv("ALL_PROXY", "http://127.0.0.1:7890");
    installRuntime();
    const lookupFn = createPublicLookup();
    const result = await guardedRequest(fetchStub(), { lookupFn, mode: "trusted_env_proxy" });
    expect(lookupFn).toHaveBeenCalledOnce();
    expect(envHttpProxyAgentCtor).not.toHaveBeenCalled();
    expect(agentCtor).toHaveBeenCalledOnce();
    await result.release();
  });

  it("rechecks redirect destinations before managed-proxy dispatch", async () => {
    managedProxy();
    const fetchImpl = vi.fn().mockResolvedValueOnce(redirectResponse("http://127.0.0.1/internal"));
    const lookupFn = createPublicLookup();
    await expect(guardedRequest(fetchImpl, { lookupFn })).rejects.toThrow(
      /private|internal|blocked/i,
    );
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(lookupFn).not.toHaveBeenCalled();
    expect(envHttpProxyAgentCtor).toHaveBeenCalledOnce();
  });

  it.each([
    { policy: { hostnameAllowlist: ["*.public.example"] }, error: /allowlist/i },
    { policy: { blockedHostnames: ["public.example"] }, error: /configured blocklist/i },
  ])("enforces trusted env hostname policy $policy before dispatch", async ({ policy, error }) => {
    clearProxyEnv();
    vi.stubEnv("HTTPS_PROXY", "http://127.0.0.1:7890");
    const fetchImpl = fetchStub();
    const lookupFn = createPublicLookup();
    await expect(
      guardedRequest(fetchImpl, { lookupFn, mode: "trusted_env_proxy", policy }),
    ).rejects.toThrow(error);
    expect(lookupFn).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each(["localhost", "api.localhost", "svc.local", "db.internal"])(
    "blocks reserved repeated-dot hostname %s",
    async (host) => {
      clearProxyEnv();
      vi.stubEnv("HTTPS_PROXY", "http://127.0.0.1:7890");
      const fetchImpl = fetchStub();
      const lookupFn = createPublicLookup();
      await expect(
        guardedRequest(fetchImpl, {
          url: `http://${host}.../resource`,
          lookupFn,
          mode: "trusted_env_proxy",
        }),
      ).rejects.toThrow(/blocked/i);
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(lookupFn).not.toHaveBeenCalled();
    },
  );

  it("keeps target allowlists separate from explicitly allowed private proxies", async () => {
    installRuntime();
    const fetchImpl = fetchStub();
    const lookupFn = vi.fn(async (host: string) => [
      { address: host === "localhost" ? "127.0.0.1" : publicAddress.address, family: 4 },
    ]);
    const result = await guardedRequest(fetchImpl, {
      lookupFn,
      policy: { hostnameAllowlist: ["public.example"] },
      dispatcherPolicy: {
        mode: "explicit-proxy",
        proxyUrl: "http://localhost:6152",
        allowPrivateProxy: true,
      },
    });
    expect(proxyAgentCtor).toHaveBeenCalledOnce();
    expect(lookupFn.mock.calls.map(([host]) => host)).toEqual(["localhost", "public.example"]);
    expect(fetchImpl).toHaveBeenCalledOnce();
    await result.release();
  });

  it("does not use target origin trust to allow a private explicit proxy", async () => {
    const fetchImpl = fetchStub();
    await expect(
      guardedRequest(fetchImpl, {
        url: "https://10.0.0.5:11434/v1/models",
        lookupFn: lookup("10.0.0.5"),
        policy: { allowedOrigins: ["https://10.0.0.5:11434"] },
        dispatcherPolicy: { mode: "explicit-proxy", proxyUrl: "http://10.0.0.5:7890" },
      }),
    ).rejects.toThrow(/blocked/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reselects proxy policy after redirects and pins direct targets", async () => {
    installRuntime();
    const lookupFn = vi.fn(async (_hostname: string) => [publicAddress]);
    const beforeRequest = vi.fn();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(redirectResponse("https://direct.example/second"))
      .mockResolvedValueOnce(redirectResponse("https://proxied.example/third"))
      .mockResolvedValueOnce(okResponse());
    const result = await guardedRequest(fetchImpl, {
      url: "https://proxied.example/first",
      lookupFn,
      beforeRequest,
      mode: "trusted_explicit_proxy",
      resolveDispatcherPolicy: (url) =>
        url.hostname === "direct.example"
          ? undefined
          : { mode: "explicit-proxy", proxyUrl: "http://proxy.example:6152" },
    });
    expect(proxyAgentCtor).toHaveBeenCalledTimes(2);
    expect(agentCtor).toHaveBeenCalledOnce();
    expect(lookupFn.mock.calls.map(([hostname]) => hostname)).toEqual([
      "proxy.example",
      "direct.example",
      "proxy.example",
    ]);
    expect(beforeRequest).toHaveBeenCalledTimes(3);
    await result.release();
  });
});

describe("configured local-origin bypass", () => {
  it.each([
    { mode: "", routing: "direct" },
    { mode: "proxy", routing: "proxy" },
    { mode: "block", routing: "blocked" },
  ])("applies $mode loopback policy through dashboard readiness", async ({ mode, routing }) => {
    managedProxy(mode);
    vi.stubEnv("NO_PROXY", "127.0.0.1");
    vi.stubEnv("no_proxy", "127.0.0.1");
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: DispatcherAwareRequestInit) => {
      dispatchAttached(input, init);
      return new Response(null, { status: 200, headers: { "content-type": "text/html" } });
    });
    const lookupFn = lookup("127.0.0.1");
    const readiness = await waitForControlUiDocument({
      url: "http://127.0.0.1:18789/dashboard/",
      deps: {
        fetch: (options) =>
          fetchConfiguredLocalOriginWithSsrFGuard({ ...options, fetchImpl, lookupFn }),
      },
    });
    expect(lookupFn).toHaveBeenCalledWith("127.0.0.1", { all: true });
    if (routing === "blocked") {
      expect(readiness).toEqual({
        ready: false,
        reason: expect.stringContaining("blocked by proxy.loopbackMode"),
      });
      expect(fetchImpl).not.toHaveBeenCalled();
    } else {
      expect(readiness).toEqual({ ready: true });
      expectDispatch(
        routing === "direct" ? agentCtor : proxyAgentCtor,
        "http://127.0.0.1:18789",
        "/dashboard/",
        "HEAD",
      );
      expect(fetchImpl).toHaveBeenCalledOnce();
    }
    expect(agentCtor).toHaveBeenCalledTimes(routing === "direct" ? 1 : 0);
    expect(proxyAgentCtor).toHaveBeenCalledTimes(routing === "proxy" ? 1 : 0);
  });

  it.each(["localhost", "[::1]"])(
    "bypasses the managed proxy for exact loopback origin %s",
    async (host) => {
      managedProxy();
      const base = `http://${host}:11434`;
      const result = await localRequest(fetchStub(), {
        url: `${base}/api/embed`,
        configuredLocalOriginBaseUrl: base,
        policy: { allowedOrigins: [base] },
        lookupFn: lookup(host === "localhost" ? "127.0.0.1" : "::1"),
      });
      expect(agentCtor).toHaveBeenCalledOnce();
      expect(envHttpProxyAgentCtor).not.toHaveBeenCalled();
      await result.release();
    },
  );

  it("keeps mixed loopback/public DNS answers on the managed proxy", async () => {
    managedProxy();
    const base = "http://localhost:11434";
    const result = await localRequest(fetchStub(), {
      url: `${base}/api/embed`,
      configuredLocalOriginBaseUrl: base,
      policy: { allowedOrigins: [base] },
      lookupFn: async () => [{ address: "127.0.0.1", family: 4 }, publicAddress],
    });
    expect(agentCtor).not.toHaveBeenCalled();
    expect(envHttpProxyAgentCtor).toHaveBeenCalledOnce();
    await result.release();
  });

  it("keeps target TLS on the managed loopback hop despite NO_PROXY", async () => {
    managedProxy("proxy");
    vi.stubEnv("NO_PROXY", "127.0.0.1");
    vi.stubEnv("no_proxy", "127.0.0.1");
    const checkServerIdentity = vi.fn();
    const baseUrl = "https://127.0.0.1:18789";
    const result = await localRequest(
      vi.fn(async (input: RequestInfo | URL, init?: DispatcherAwareRequestInit) =>
        dispatchAttached(input, init),
      ),
      {
        url: `${baseUrl}/dashboard/`,
        configuredLocalOriginBaseUrl: baseUrl,
        policy: { allowedOrigins: [baseUrl] },
        dispatcherPolicy: {
          mode: "direct",
          connect: { ca: "gateway-certificate", checkServerIdentity },
        },
      },
    );
    expect(proxyAgentCtor).toHaveBeenCalledWith(
      expect.objectContaining({ requestTls: { ca: "gateway-certificate", checkServerIdentity } }),
    );
    expect(recordedCall(proxyAgentCtor.mock.calls)[0]).not.toHaveProperty("proxyTls.ca");
    expectDispatch(proxyAgentCtor, baseUrl, "/dashboard/");
    await result.release();
  });

  it("ignores hidden bypass markers on the public guard", async () => {
    managedProxy();
    const options = {
      url: `${localBase}/api/embed`,
      fetchImpl: fetchStub(),
      lookupFn: lookup("127.0.0.1"),
      policy: { allowedOrigins: [localBase] },
      managedProxyBypass: { kind: "configured-local-origin", baseUrl: localBase },
    };
    const result = await fetchWithSsrFGuard(options);
    expect(envHttpProxyAgentCtor).toHaveBeenCalledOnce();
    expect(agentCtor).not.toHaveBeenCalled();
    await result.release();
  });

  it("does not carry direct routing across redirects to another loopback port", async () => {
    managedProxy();
    const nextBase = "http://127.0.0.1:11435";
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(redirectResponse(`${nextBase}/api/embed`))
      .mockResolvedValueOnce(okResponse());
    const result = await localRequest(fetchImpl, {
      policy: { allowedOrigins: [localBase, nextBase], allowPrivateNetwork: true },
    });
    expect(result.finalUrl).toBe(`${nextBase}/api/embed`);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(agentCtor).toHaveBeenCalledOnce();
    expect(envHttpProxyAgentCtor).toHaveBeenCalledOnce();
    await result.release();
  });

  it("keeps public configured origins on the managed proxy without trusting loopback DNS", async () => {
    managedProxy();
    const lookupFn = lookup("127.0.0.1");
    const result = await localRequest(fetchStub(), {
      url: publicUrl,
      configuredLocalOriginBaseUrl: "https://public.example",
      lookupFn,
      policy: { allowedOrigins: ["https://public.example"] },
    });
    expect(lookupFn).not.toHaveBeenCalled();
    expect(agentCtor).not.toHaveBeenCalled();
    expect(envHttpProxyAgentCtor).toHaveBeenCalledOnce();
    await result.release();
  });
});

describe("request lifecycle", () => {
  it("blocks a private DNS rebind before consulting a warm dispatcher", async () => {
    installRuntime();
    const pool = new PinnedDispatcherPool({ maxEntries: 2, idleTtlMs: 60_000 });
    const lookupFn = vi
      .fn()
      .mockResolvedValueOnce([publicAddress])
      .mockResolvedValueOnce([{ address: "127.0.0.1", family: 4 }]);
    const fetchImpl = fetchStub();
    try {
      const first = await guardedRequest(fetchImpl, { lookupFn, dispatcherPool: pool });
      await first.release();
      await expect(guardedRequest(fetchImpl, { lookupFn, dispatcherPool: pool })).rejects.toThrow(
        /private|internal|blocked/i,
      );
      expect(fetchImpl).toHaveBeenCalledOnce();
      expect(agentCtor).toHaveBeenCalledOnce();
    } finally {
      await pool.closeAll();
    }
  });

  it("inherits the global stream timeout and checks authority after DNS", async () => {
    ensureGlobalUndiciStreamTimeouts({ timeoutMs: 1_900_000 });
    installRuntime();
    const fetchImpl = fetchStub();
    const beforeRequest = vi.fn();
    const lookupFn = createPublicLookup();
    const result = await guardedRequest(fetchImpl, { lookupFn, beforeRequest });
    expect(lookupFn).toHaveBeenCalledBefore(beforeRequest);
    expect(beforeRequest).toHaveBeenCalledBefore(fetchImpl);
    expect(agentCtor).toHaveBeenCalledWith(
      expect.objectContaining({
        allowH2: false,
        bodyTimeout: 1_900_000,
        headersTimeout: 1_900_000,
        connect: expect.objectContaining({ lookup: expect.any(Function) }),
      }),
    );
    await result.release();
  });

  it("propagates a final dispatch rejection without sending the request", async () => {
    const rejection = new Error("request owner closed");
    const fetchImpl = fetchStub();
    await expect(
      guardedRequest(fetchImpl, {
        beforeRequest: () => {
          throw rejection;
        },
      }),
    ).rejects.toBe(rejection);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects an asynchronous final dispatch callback before sending the request", async () => {
    const fetchImpl = fetchStub();
    await expect(
      guardedRequest(fetchImpl, {
        beforeRequest: (() => Promise.resolve()) as never,
      }),
    ).rejects.toThrow("beforeRequest must be synchronous");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each(["caller", "deadline"])(
    "aborts stalled DNS from the %s before dispatch",
    async (source) => {
      const started = createDeferredCore();
      const pending = createDeferredCore<Array<typeof publicAddress>>();
      const lookupFn = vi.fn(() => {
        started.resolve();
        return pending.promise;
      });
      const fetchImpl = fetchStub();
      const controller = new AbortController();
      const reason = new Error("gateway shutdown");
      vi.useFakeTimers();
      try {
        const result = guardedRequest(fetchImpl, {
          lookupFn,
          signal: controller.signal,
          timeoutMs: source === "deadline" ? 1 : undefined,
        }).catch((error: unknown) => error);
        await started.promise;
        if (source === "caller") {
          controller.abort(reason);
        } else {
          await vi.advanceTimersByTimeAsync(1);
        }
        if (source === "caller") {
          expect(await result).toBe(reason);
        } else {
          expect(await result).toMatchObject({ name: "TimeoutError" });
        }
        expect(fetchImpl).not.toHaveBeenCalled();
        pending.resolve([publicAddress]);
        await Promise.resolve();
        expect(fetchImpl).not.toHaveBeenCalled();
      } finally {
        pending.resolve([publicAddress]);
        vi.useRealTimers();
      }
    },
  );
});
