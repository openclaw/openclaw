import { EnvHttpProxyAgent } from "undici";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchWithSsrFGuard, GUARDED_FETCH_MODE } from "./fetch-guard.js";

function redirectResponse(location: string): Response {
  return new Response(null, {
    status: 302,
    headers: { location },
  });
}

function okResponse(body = "ok"): Response {
  return new Response(body, { status: 200 });
}

describe("fetchWithSsrFGuard hardening", () => {
  type LookupFn = NonNullable<Parameters<typeof fetchWithSsrFGuard>[0]["lookupFn"]>;
  const CROSS_ORIGIN_REDIRECT_STRIPPED_HEADERS = [
    "authorization",
    "proxy-authorization",
    "cookie",
    "cookie2",
    "x-api-key",
    "private-token",
    "x-trace",
  ] as const;
  const CROSS_ORIGIN_REDIRECT_PRESERVED_HEADERS = [
    ["accept", "application/json"],
    ["content-type", "application/json"],
    ["user-agent", "OpenClaw-Test/1.0"],
  ] as const;

  const createPublicLookup = (): LookupFn =>
    vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]) as unknown as LookupFn;

  const getSecondRequestHeaders = (fetchImpl: ReturnType<typeof vi.fn>): Headers => {
    const [, secondInit] = fetchImpl.mock.calls[1] as [string, RequestInit];
    return new Headers(secondInit.headers);
  };

  async function runProxyModeDispatcherTest(params: {
    mode: (typeof GUARDED_FETCH_MODE)[keyof typeof GUARDED_FETCH_MODE];
    expectEnvProxy: boolean;
  }): Promise<void> {
    vi.stubEnv("HTTP_PROXY", "http://127.0.0.1:7890");
    const lookupFn = createPublicLookup();
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const requestInit = init as RequestInit & { dispatcher?: unknown };
      if (params.expectEnvProxy) {
        expect(requestInit.dispatcher).toBeInstanceOf(EnvHttpProxyAgent);
      } else {
        expect(requestInit.dispatcher).toBeDefined();
        expect(requestInit.dispatcher).not.toBeInstanceOf(EnvHttpProxyAgent);
      }
      return okResponse();
    });

    const result = await fetchWithSsrFGuard({
      url: "https://public.example/resource",
      fetchImpl,
      lookupFn,
      mode: params.mode,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await result.release();
  }

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("blocks private and legacy loopback literals before fetch", async () => {
    const blockedUrls = [
      "http://127.0.0.1:8080/internal",
      "http://[ff02::1]/internal",
      "http://0177.0.0.1:8080/internal",
      "http://0x7f000001/internal",
    ];
    for (const url of blockedUrls) {
      const fetchImpl = vi.fn();
      await expect(
        fetchWithSsrFGuard({
          url,
          fetchImpl,
        }),
      ).rejects.toThrow(/private|internal|blocked/i);
      expect(fetchImpl).not.toHaveBeenCalled();
    }
  });

  it("blocks special-use IPv4 literal URLs before fetch", async () => {
    const fetchImpl = vi.fn();
    await expect(
      fetchWithSsrFGuard({
        url: "http://198.18.0.1:8080/internal",
        fetchImpl,
      }),
    ).rejects.toThrow(/private|internal|blocked/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("allows RFC2544 benchmark range IPv4 literal URLs when explicitly opted in", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(new Response("ok", { status: 200 }));
    const result = await fetchWithSsrFGuard({
      url: "http://198.18.0.153/file",
      fetchImpl,
      policy: { allowRfc2544BenchmarkRange: true },
    });
    expect(result.response.status).toBe(200);
  });

  it("blocks redirect chains that hop to private hosts", async () => {
    const lookupFn = createPublicLookup();
    const fetchImpl = vi.fn().mockResolvedValueOnce(redirectResponse("http://127.0.0.1:6379/"));

    await expect(
      fetchWithSsrFGuard({
        url: "https://public.example/start",
        fetchImpl,
        lookupFn,
      }),
    ).rejects.toThrow(/private|internal|blocked/i);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("enforces hostname allowlist policies", async () => {
    const fetchImpl = vi.fn();
    await expect(
      fetchWithSsrFGuard({
        url: "https://evil.example.org/file.txt",
        fetchImpl,
        policy: { hostnameAllowlist: ["cdn.example.com", "*.assets.example.com"] },
      }),
    ).rejects.toThrow(/allowlist/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("allows wildcard allowlisted hosts", async () => {
    const lookupFn = createPublicLookup();
    const fetchImpl = vi.fn(async () => new Response("ok", { status: 200 }));
    const result = await fetchWithSsrFGuard({
      url: "https://img.assets.example.com/pic.png",
      fetchImpl,
      lookupFn,
      policy: { hostnameAllowlist: ["*.assets.example.com"] },
    });

    expect(result.response.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await result.release();
  });

  it("strips sensitive headers when redirect crosses origins", async () => {
    const lookupFn = createPublicLookup();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(redirectResponse("https://cdn.example.com/asset"))
      .mockResolvedValueOnce(okResponse());

    const result = await fetchWithSsrFGuard({
      url: "https://api.example.com/start",
      fetchImpl,
      lookupFn,
      init: {
        headers: {
          Authorization: "Bearer secret",
          "Proxy-Authorization": "Basic c2VjcmV0",
          Cookie: "session=abc",
          Cookie2: "legacy=1",
          "X-Api-Key": "custom-secret",
          "Private-Token": "private-secret",
          "X-Trace": "1",
          Accept: "application/json",
          "Content-Type": "application/json",
          "User-Agent": "OpenClaw-Test/1.0",
        },
      },
    });

    const headers = getSecondRequestHeaders(fetchImpl);
    for (const header of CROSS_ORIGIN_REDIRECT_STRIPPED_HEADERS) {
      expect(headers.get(header)).toBeNull();
    }
    for (const [header, value] of CROSS_ORIGIN_REDIRECT_PRESERVED_HEADERS) {
      expect(headers.get(header)).toBe(value);
    }
    await result.release();
  });

  it("keeps headers when redirect stays on same origin", async () => {
    const lookupFn = createPublicLookup();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(redirectResponse("/next"))
      .mockResolvedValueOnce(okResponse());

    const result = await fetchWithSsrFGuard({
      url: "https://api.example.com/start",
      fetchImpl,
      lookupFn,
      init: {
        headers: {
          Authorization: "Bearer secret",
        },
      },
    });

    const headers = getSecondRequestHeaders(fetchImpl);
    expect(headers.get("authorization")).toBe("Bearer secret");
    await result.release();
  });

  it("ignores env proxy by default to preserve DNS-pinned destination binding", async () => {
    await runProxyModeDispatcherTest({
      mode: GUARDED_FETCH_MODE.STRICT,
      expectEnvProxy: false,
    });
  });

  it("uses env proxy only when dangerous proxy bypass is explicitly enabled", async () => {
    await runProxyModeDispatcherTest({
      mode: GUARDED_FETCH_MODE.TRUSTED_ENV_PROXY,
      expectEnvProxy: true,
    });
  });

  it("forwards connectOptions to pinned dispatcher (regression: 45b74fb56c)", async () => {
    // Regression test: Telegram media downloads go through fetchWithSsrFGuard which
    // creates a pinned dispatcher. The telegram fetch wrapper's IPv4 fallback is
    // skipped when callerProvidedDispatcher is true (always the case for SSRF guard).
    // Callers must be able to pass connectOptions (e.g. autoSelectFamily: false) to
    // prevent IPv6 timeouts in dual-stack environments with broken IPv6 routes.
    const lookupFn = createPublicLookup();
    let capturedDispatcher: unknown = null;
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedDispatcher = (init as RequestInit & { dispatcher?: unknown }).dispatcher;
      return okResponse();
    });

    const result = await fetchWithSsrFGuard({
      url: "https://api.telegram.org/file/botTOKEN/documents/file_42.pdf",
      fetchImpl,
      lookupFn,
      connectOptions: { autoSelectFamily: false },
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(capturedDispatcher).toBeDefined();
    expect(capturedDispatcher).not.toBeInstanceOf(EnvHttpProxyAgent);
    await result.release();
  });

  it("does not set connect options on pinned dispatcher when connectOptions is omitted", async () => {
    const lookupFn = createPublicLookup();
    let capturedDispatcher: unknown = null;
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedDispatcher = (init as RequestInit & { dispatcher?: unknown }).dispatcher;
      return okResponse();
    });

    const result = await fetchWithSsrFGuard({
      url: "https://example.com/file.pdf",
      fetchImpl,
      lookupFn,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    // Dispatcher is present (pinned) but without connect options override
    expect(capturedDispatcher).toBeDefined();
    expect(capturedDispatcher).not.toBeInstanceOf(EnvHttpProxyAgent);
    await result.release();
  });
});
