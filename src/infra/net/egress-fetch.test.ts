// HTTP egress helper tests cover the shared fetch mechanics and the narrow
// direct-mode stock guard for untrusted arbitrary URLs.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchOperatorConfiguredEndpoint,
  fetchUntrustedUrl,
  fetchWithEgressPolicy,
  resolveEgressDispatcherPolicy,
} from "./egress-fetch.js";
import { SsrFBlockedError, type LookupFn } from "./ssrf.js";
import { TEST_UNDICI_RUNTIME_DEPS_KEY } from "./undici-runtime.js";

const { agentCtor, fetchRuntimeMock } = vi.hoisted(() => ({
  agentCtor: vi.fn(function MockAgent(this: { close: () => Promise<void> }, _options: unknown) {
    this.close = vi.fn(async () => undefined);
  }),
  fetchRuntimeMock: vi.fn(),
}));
const { captureHttpExchangeMock, isDebugProxyGlobalFetchPatchInstalledMock } = vi.hoisted(() => ({
  captureHttpExchangeMock: vi.fn(),
  isDebugProxyGlobalFetchPatchInstalledMock: vi.fn(() => false),
}));

vi.mock("../../proxy-capture/runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../proxy-capture/runtime.js")>()),
  captureHttpExchange: captureHttpExchangeMock,
  isDebugProxyGlobalFetchPatchInstalled: isDebugProxyGlobalFetchPatchInstalledMock,
}));

class MockEnvHttpProxyAgent {
  close = vi.fn(async () => undefined);
}

class MockProxyAgent {
  close = vi.fn(async () => undefined);
}

function publicLookup(): LookupFn {
  return vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]) as unknown as LookupFn;
}

function privateLookup(): LookupFn {
  return vi.fn(async () => [{ address: "10.0.0.5", family: 4 }]) as unknown as LookupFn;
}

function pendingFetchThatRejectsOnAbort(): typeof fetch {
  return vi.fn((_url: RequestInfo | URL, init?: RequestInit) => {
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        const reason = init.signal?.reason;
        reject(reason instanceof Error ? reason : new Error("aborted"));
      });
    });
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  fetchRuntimeMock.mockReset();
  agentCtor.mockClear();
  captureHttpExchangeMock.mockClear();
  isDebugProxyGlobalFetchPatchInstalledMock.mockReset();
  isDebugProxyGlobalFetchPatchInstalledMock.mockReturnValue(false);
  (globalThis as Record<string, unknown>)[TEST_UNDICI_RUNTIME_DEPS_KEY] = {
    Agent: agentCtor,
    EnvHttpProxyAgent: MockEnvHttpProxyAgent,
    ProxyAgent: MockProxyAgent,
    fetch: fetchRuntimeMock,
  };
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(globalThis as object, TEST_UNDICI_RUNTIME_DEPS_KEY);
});

describe("fetchWithEgressPolicy", () => {
  it("rejects non-HTTP schemes before fetching", async () => {
    const fetchImpl = vi.fn();

    await expect(
      fetchWithEgressPolicy({
        url: "file:///tmp/data",
        fetchImpl,
      }),
    ).rejects.toThrow("only supports http and https URLs");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("applies timeout signals to the fetch", async () => {
    vi.useFakeTimers();
    const promise = fetchWithEgressPolicy({
      url: "https://example.com/slow",
      fetchImpl: pendingFetchThatRejectsOnAbort(),
      timeoutMs: 25,
    });
    const rejection = expect(promise).rejects.toThrow(/timed out/i);

    await vi.advanceTimersByTimeAsync(25);

    await rejection;
  });

  it("returns a release helper that cancels the response body", async () => {
    const cancel = vi.fn();
    const response = new Response(
      new ReadableStream({
        cancel,
        start(controller) {
          controller.enqueue(new TextEncoder().encode("body"));
        },
      }),
    );

    const result = await fetchWithEgressPolicy({
      url: "https://example.com/body",
      fetchImpl: vi.fn(async () => response),
    });
    await result.release();

    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("strips credential headers and drops unsafe bodies on cross-origin redirects", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 307,
          headers: { location: "https://cdn.example.net/upload" },
        }),
      )
      .mockResolvedValueOnce(new Response("ok"));

    const result = await fetchWithEgressPolicy({
      url: "https://api.example.com/upload",
      init: {
        method: "POST",
        headers: {
          accept: "application/json",
          authorization: "Bearer secret",
          cookie: "session=secret",
          "content-type": "application/json",
          "proxy-authorization": "Basic secret",
        },
        body: "{}",
      },
      fetchImpl,
    });

    await result.release();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const redirectedInit = fetchImpl.mock.calls[1]?.[1] as RequestInit;
    const redirectedHeaders = new Headers(redirectedInit.headers);
    expect(redirectedInit.body).toBeUndefined();
    expect(redirectedHeaders.get("accept")).toBe("application/json");
    expect(redirectedHeaders.has("authorization")).toBe(false);
    expect(redirectedHeaders.has("cookie")).toBe(false);
    expect(redirectedHeaders.has("proxy-authorization")).toBe(false);
    expect(redirectedHeaders.has("content-type")).toBe(false);
    expect(result.finalUrl).toBe("https://cdn.example.net/upload");
  });

  it("runs URL validation on redirect targets", async () => {
    const validateUrl = vi.fn((url: URL) => {
      if (url.hostname === "blocked.example") {
        throw new Error("blocked redirect");
      }
    });
    const fetchImpl = vi.fn(async () => {
      return new Response(null, {
        status: 302,
        headers: { location: "https://blocked.example/final" },
      });
    });

    await expect(
      fetchWithEgressPolicy({
        url: "https://example.com/start",
        fetchImpl,
        validateUrl,
      }),
    ).rejects.toThrow("blocked redirect");
    expect(validateUrl.mock.calls.map(([url]) => url.hostname)).toEqual([
      "example.com",
      "blocked.example",
    ]);
  });

  it("closes a created dispatcher when fetch setup fails", async () => {
    fetchRuntimeMock.mockRejectedValueOnce(new Error("network setup failed"));

    await expect(
      fetchWithEgressPolicy({
        url: "https://example.com/fail",
        dispatcherPolicy: { mode: "direct" },
      }),
    ).rejects.toThrow("network setup failed");

    const dispatcher = agentCtor.mock.instances[0] as { close?: ReturnType<typeof vi.fn> };
    expect(dispatcher.close).toHaveBeenCalledTimes(1);
  });

  it("honors a caller-owned direct dispatcher decision when env proxy use is disabled", () => {
    const envProxyKey = ["HTTPS", "PROXY"].join("_");
    vi.stubEnv(envProxyKey, "http://127.0.0.1:3128");

    const policy = resolveEgressDispatcherPolicy({
      url: "https://127.0.0.1:11434/api/embeddings",
      dispatcherPolicy: { mode: "direct" },
      useEnvProxy: false,
    });

    expect(policy).toEqual({ mode: "direct" });
  });
});

describe("fetchUntrustedUrl", () => {
  it.each([
    ["localhost hostname", "http://localhost/status"],
    ["metadata hostname", "http://metadata.google.internal/latest"],
    ["loopback IP", "http://127.0.0.1/status"],
    ["private IP", "http://10.0.0.1/status"],
    ["link-local IP", "http://169.254.169.254/latest"],
  ])("blocks %s when proxy is disabled", async (_name, url) => {
    await expect(
      fetchUntrustedUrl({
        url,
        fetchImpl: vi.fn(),
        lookupFn: publicLookup(),
        proxyEnabled: false,
      }),
    ).rejects.toBeInstanceOf(SsrFBlockedError);
  });

  it("blocks DNS results that resolve to private or local addresses", async () => {
    await expect(
      fetchUntrustedUrl({
        url: "https://example.com/data",
        fetchImpl: vi.fn(),
        lookupFn: privateLookup(),
        proxyEnabled: false,
      }),
    ).rejects.toBeInstanceOf(SsrFBlockedError);
  });

  it("allows public IPv6 literal URLs without DNS lookup", async () => {
    const lookupFn = publicLookup();
    const fetchImpl = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) => new Response("ok"),
    );

    const result = await fetchUntrustedUrl({
      url: "https://[2606:4700:4700::1111]/cdn-cgi/trace",
      fetchImpl,
      lookupFn,
      proxyEnabled: false,
    });

    expect(lookupFn).not.toHaveBeenCalled();
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://[2606:4700:4700::1111]/cdn-cgi/trace",
      expect.objectContaining({ redirect: "manual" }),
    );
    await result.release();
  });

  it("uses a direct dispatcher instead of ambient env proxies in direct mode", async () => {
    const envProxyKey = ["HTTPS", "PROXY"].join("_");
    vi.stubEnv(envProxyKey, "http://127.0.0.1:3128");
    const fetchImpl = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) => new Response("ok"),
    );

    const result = await fetchUntrustedUrl({
      url: "https://example.com/data",
      fetchImpl,
      lookupFn: publicLookup(),
      proxyEnabled: false,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const init = fetchImpl.mock.calls[0]?.[1] as { dispatcher?: unknown } | undefined;
    expect(agentCtor).toHaveBeenCalledTimes(1);
    expect(init?.dispatcher).toBe(agentCtor.mock.instances[0]);
    await result.release();
  });

  it("pins direct dispatchers to the validated address set", async () => {
    const lookupFn = vi
      .fn()
      .mockResolvedValueOnce([{ address: "93.184.216.34", family: 4 }])
      .mockResolvedValueOnce([{ address: "127.0.0.1", family: 4 }]) as unknown as LookupFn;
    const fetchImpl = vi.fn(async () => new Response("ok"));

    const result = await fetchUntrustedUrl({
      url: "https://example.com/data",
      fetchImpl,
      lookupFn,
      proxyEnabled: false,
    });

    expect(lookupFn).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const agentOptions = (
      agentCtor.mock.calls as Array<[{ connect?: { lookup?: unknown } }]>
    )[0]?.[0];
    const lookup = agentOptions?.connect?.lookup;
    expect(typeof lookup).toBe("function");
    await new Promise<void>((resolve, reject) => {
      (
        lookup as (
          host: string,
          options: { all: true },
          callback: (error: Error | null, records?: unknown) => void,
        ) => void
      )("example.com", { all: true }, (error, records) => {
        if (error) {
          reject(error);
          return;
        }
        expect(records).toEqual([{ address: "93.184.216.34", family: 4 }]);
        resolve();
      });
    });
    await result.release();
  });

  it("captures direct-dispatched untrusted fetches when debug proxy capture is enabled", async () => {
    vi.stubEnv("OPENCLAW_DEBUG_PROXY_ENABLED", "1");
    vi.stubEnv("OPENCLAW_DEBUG_PROXY_DB_PATH", "/tmp/openclaw-egress-fetch-test.sqlite");
    vi.stubEnv("OPENCLAW_DEBUG_PROXY_BLOB_DIR", "/tmp/openclaw-egress-fetch-test-blobs");
    fetchRuntimeMock.mockResolvedValueOnce(new Response("ok"));

    const result = await fetchUntrustedUrl({
      url: "https://example.com/data",
      lookupFn: publicLookup(),
      proxyEnabled: false,
    });

    expect(fetchRuntimeMock).toHaveBeenCalledTimes(1);
    expect(captureHttpExchangeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://example.com/data",
        method: "GET",
        response: result.response,
        transport: "http",
        meta: {
          captureOrigin: "untrusted-url-fetch",
        },
      }),
      expect.objectContaining({ enabled: true }),
    );
    await result.release();
  });

  it("runs caller URL validation before direct-mode DNS lookup", async () => {
    const lookupFn = publicLookup();

    await expect(
      fetchUntrustedUrl({
        url: "https://blocked.example/data",
        fetchImpl: vi.fn(),
        lookupFn,
        proxyEnabled: false,
        validateUrl: () => {
          throw new Error("blocked by caller allowlist");
        },
      }),
    ).rejects.toThrow("blocked by caller allowlist");
    expect(lookupFn).not.toHaveBeenCalled();
  });

  it("blocks redirect targets to private or local destinations", async () => {
    const fetchImpl = vi.fn(async () => {
      return new Response(null, {
        status: 302,
        headers: { location: "http://10.0.0.1/admin" },
      });
    });

    await expect(
      fetchUntrustedUrl({
        url: "https://example.com/start",
        fetchImpl,
        lookupFn: publicLookup(),
        proxyEnabled: false,
      }),
    ).rejects.toBeInstanceOf(SsrFBlockedError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("leaves destination policy to the configured proxy when proxy is enabled", async () => {
    const fetchImpl = vi.fn(async () => new Response("ok"));

    const result = await fetchUntrustedUrl({
      url: "http://10.0.0.1/status",
      fetchImpl,
      lookupFn: privateLookup(),
      proxyEnabled: true,
    });

    expect(result.response.status).toBe(200);
    await result.release();
  });
});

describe("fetchOperatorConfiguredEndpoint", () => {
  it("treats private-network endpoints as operator intent", async () => {
    const fetchImpl = vi.fn(async () => new Response("ok"));

    const result = await fetchOperatorConfiguredEndpoint({
      url: "http://127.0.0.1:11434/api/tags",
      fetchImpl,
    });

    expect(result.response.status).toBe(200);
    await result.release();
  });
});
