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

function getDispatcherClassName(value: unknown): string | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const ctor = (value as { constructor?: unknown }).constructor;
  return typeof ctor === "function" && ctor.name ? ctor.name : null;
}

function getSecondRequestHeaders(fetchImpl: ReturnType<typeof vi.fn>): Headers {
  const [, secondInit] = fetchImpl.mock.calls[1] as [string, RequestInit];
  return new Headers(secondInit.headers);
}

async function expectRedirectFailure(params: {
  url: string;
  responses: Response[];
  expectedError: RegExp;
  lookupFn?: NonNullable<Parameters<typeof fetchWithSsrFGuard>[0]["lookupFn"]>;
  maxRedirects?: number;
}) {
  const fetchImpl = vi.fn();
  for (const response of params.responses) {
    fetchImpl.mockResolvedValueOnce(response);
  }

  await expect(
    fetchWithSsrFGuard({
      url: params.url,
      fetchImpl,
      ...(params.lookupFn ? { lookupFn: params.lookupFn } : {}),
      ...(params.maxRedirects === undefined ? {} : { maxRedirects: params.maxRedirects }),
    }),
  ).rejects.toThrow(params.expectedError);
  return fetchImpl;
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

  async function runProxyModeDispatcherTest(params: {
    mode: (typeof GUARDED_FETCH_MODE)[keyof typeof GUARDED_FETCH_MODE];
    expectEnvProxy: boolean;
  }): Promise<void> {
    vi.stubEnv("HTTP_PROXY", "http://127.0.0.1:7890");
    const lookupFn = createPublicLookup();
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const requestInit = init as RequestInit & { dispatcher?: unknown };
      if (params.expectEnvProxy) {
        expect(getDispatcherClassName(requestInit.dispatcher)).toBe("EnvHttpProxyAgent");
      } else {
        expect(requestInit.dispatcher).toBeDefined();
        expect(getDispatcherClassName(requestInit.dispatcher)).not.toBe("EnvHttpProxyAgent");
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

  it("fails closed for plain HTTP targets when explicit proxy mode requires pinned DNS", async () => {
    const fetchImpl = vi.fn();
    await expect(
      fetchWithSsrFGuard({
        url: "http://public.example/resource",
        fetchImpl,
        dispatcherPolicy: {
          mode: "explicit-proxy",
          proxyUrl: "http://127.0.0.1:7890",
        },
      }),
    ).rejects.toThrow(/explicit proxy ssrf pinning requires https targets/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("blocks redirect chains that hop to private hosts", async () => {
    const lookupFn = createPublicLookup();
    const fetchImpl = await expectRedirectFailure({
      url: "https://public.example/start",
      responses: [redirectResponse("http://127.0.0.1:6379/")],
      expectedError: /private|internal|blocked/i,
      lookupFn,
    });
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

  it("does not let wildcard allowlists match the apex host", async () => {
    const fetchImpl = vi.fn();
    await expect(
      fetchWithSsrFGuard({
        url: "https://assets.example.com/pic.png",
        fetchImpl,
        policy: { hostnameAllowlist: ["*.assets.example.com"] },
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

  it.each([
    {
      name: "rejects redirects without a location header",
      responses: [new Response(null, { status: 302 })],
      expectedError: /missing location header/i,
      maxRedirects: undefined,
    },
    {
      name: "rejects redirect loops",
      responses: [
        redirectResponse("https://public.example/next"),
        redirectResponse("https://public.example/next"),
      ],
      expectedError: /redirect loop/i,
      maxRedirects: undefined,
    },
    {
      name: "rejects too many redirects",
      responses: [
        redirectResponse("https://public.example/one"),
        redirectResponse("https://public.example/two"),
      ],
      expectedError: /too many redirects/i,
      maxRedirects: 1,
    },
  ])("$name", async ({ responses, expectedError, maxRedirects }) => {
    await expectRedirectFailure({
      url: "https://public.example/start",
      responses,
      expectedError,
      lookupFn: createPublicLookup(),
      maxRedirects,
    });
  });

  it("blocks URLs that use credentials to obscure a private host", async () => {
    const fetchImpl = vi.fn();
    // http://attacker.com@127.0.0.1:8080/ — URL parser extracts hostname as 127.0.0.1
    await expect(
      fetchWithSsrFGuard({
        url: "http://attacker.com@127.0.0.1:8080/internal",
        fetchImpl,
      }),
    ).rejects.toThrow(/private|internal|blocked/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("blocks private IPv6 addresses embedded in URLs with credentials", async () => {
    const fetchImpl = vi.fn();
    await expect(
      fetchWithSsrFGuard({
        url: "http://user:pass@[::1]:8080/internal",
        fetchImpl,
      }),
    ).rejects.toThrow(/private|internal|blocked/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("blocks redirect to a URL using credentials to obscure a private host", async () => {
    const lookupFn = createPublicLookup();
    const fetchImpl = await expectRedirectFailure({
      url: "https://public.example/start",
      responses: [redirectResponse("http://public@127.0.0.1:6379/")],
      expectedError: /private|internal|blocked/i,
      lookupFn,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("routes through env proxy in strict mode via pinned env-proxy dispatcher", async () => {
    await runProxyModeDispatcherTest({
      mode: GUARDED_FETCH_MODE.STRICT,
      expectEnvProxy: true,
    });
  });

  it("keeps allowed hostnames on the direct pinned path when env proxy is configured", async () => {
    vi.stubEnv("HTTP_PROXY", "http://127.0.0.1:7890");
    const lookupFn = createPublicLookup();
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const requestInit = init as RequestInit & { dispatcher?: unknown };
      expect(requestInit.dispatcher).toBeDefined();
      expect(getDispatcherClassName(requestInit.dispatcher)).not.toBe("EnvHttpProxyAgent");
      return okResponse();
    });

    const result = await fetchWithSsrFGuard({
      url: "https://operator.example/resource",
      fetchImpl,
      lookupFn,
      policy: { allowedHostnames: ["operator.example"] },
      mode: GUARDED_FETCH_MODE.STRICT,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await result.release();
  });

  it("still uses env proxy when allowed hostnames do not match the target", async () => {
    vi.stubEnv("HTTP_PROXY", "http://127.0.0.1:7890");
    const lookupFn = createPublicLookup();
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const requestInit = init as RequestInit & { dispatcher?: unknown };
      expect(getDispatcherClassName(requestInit.dispatcher)).toBe("EnvHttpProxyAgent");
      return okResponse();
    });

    const result = await fetchWithSsrFGuard({
      url: "https://public.example/resource",
      fetchImpl,
      lookupFn,
      policy: { allowedHostnames: ["operator.example"] },
      mode: GUARDED_FETCH_MODE.STRICT,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await result.release();
  });

  it("routes through env proxy when trusted proxy mode is explicitly enabled", async () => {
    await runProxyModeDispatcherTest({
      mode: GUARDED_FETCH_MODE.TRUSTED_ENV_PROXY,
      expectEnvProxy: true,
    });
  });
});
