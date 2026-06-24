// web_fetch SSRF tests cover URL, DNS, redirect, and proxy policy enforcement
// before network requests reach fetch or provider fallbacks.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as ssrf from "../../infra/net/ssrf.js";
import { type FetchMock, withFetchPreconnect } from "../../test-utils/fetch-mock.js";
import { createWebFetchTool } from "./web-fetch.js";
import { makeFetchHeaders } from "./web-fetch.test-harness.js";
import "./web-fetch.test-mocks.js";

const lookupMock = vi.fn();
const resolvePinnedHostname = ssrf.resolvePinnedHostname;
const logWarnMock = vi.hoisted(() => vi.fn());

vi.mock("../../logger.js", async () => {
  const actual = await vi.importActual<typeof import("../../logger.js")>("../../logger.js");
  return { ...actual, logWarn: logWarnMock };
});

function redirectResponse(location: string): Response {
  return {
    ok: false,
    status: 302,
    headers: makeFetchHeaders({ location }),
    body: { cancel: vi.fn() },
  } as unknown as Response;
}

function textResponse(body: string): Response {
  return {
    ok: true,
    status: 200,
    headers: makeFetchHeaders({ "content-type": "text/plain" }),
    text: async () => body,
  } as unknown as Response;
}

function setMockFetch(
  impl: FetchMock = async (_input: RequestInfo | URL, _init?: RequestInit) => textResponse(""),
) {
  const fetchSpy = vi.fn(impl);
  global.fetch = withFetchPreconnect(fetchSpy);
  return fetchSpy;
}

function expectRawFetchSuccessDetails(details: unknown) {
  const typedDetails = details as { status?: number; extractor?: string };
  expect(typedDetails.status).toBe(200);
  expect(typedDetails.extractor).toBe("raw");
}

function firstFetchUrl(fetchSpy: ReturnType<typeof setMockFetch>): string {
  const input = fetchSpy.mock.calls[0]?.[0];
  return input instanceof Request ? input.url : input instanceof URL ? input.href : input;
}

function createWebFetchToolForTest(params?: {
  firecrawlApiKey?: string;
  useTrustedEnvProxy?: boolean;
  ssrfPolicy?: {
    allowRfc2544BenchmarkRange?: boolean;
    allowIpv6UniqueLocalRange?: boolean;
    hostnameAllowlist?: string[];
  };
  cacheTtlMinutes?: number;
}) {
  return createWebFetchTool({
    config: {
      plugins: params?.firecrawlApiKey
        ? {
            entries: {
              firecrawl: {
                config: {
                  webFetch: {
                    apiKey: params.firecrawlApiKey,
                  },
                },
              },
            },
          }
        : undefined,
      tools: {
        web: {
          fetch: {
            cacheTtlMinutes: params?.cacheTtlMinutes ?? 0,
            useTrustedEnvProxy: params?.useTrustedEnvProxy,
            ssrfPolicy: params?.ssrfPolicy,
            ...(params?.firecrawlApiKey ? { provider: "firecrawl" } : {}),
          },
        },
      },
    },
    lookupFn: lookupMock,
  });
}

async function expectBlockedUrl(
  tool: ReturnType<typeof createWebFetchToolForTest>,
  url: string,
  expectedMessage: RegExp,
) {
  await expect(tool?.execute?.("call", { url })).rejects.toThrow(expectedMessage);
}

describe("web_fetch SSRF protection", () => {
  const priorFetch = global.fetch;

  beforeEach(() => {
    vi.spyOn(ssrf, "resolvePinnedHostname").mockImplementation((hostname) =>
      resolvePinnedHostname(hostname, lookupMock),
    );
  });

  afterEach(() => {
    global.fetch = priorFetch;
    lookupMock.mockClear();
    logWarnMock.mockClear();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("blocks localhost hostnames before fetch/firecrawl", async () => {
    const fetchSpy = setMockFetch();
    const tool = createWebFetchToolForTest({
      firecrawlApiKey: "firecrawl-test", // pragma: allowlist secret
    });

    await expectBlockedUrl(tool, "http://localhost/test", /Blocked hostname/i);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it("blocks private IP literals without DNS", async () => {
    const fetchSpy = setMockFetch();
    const tool = createWebFetchToolForTest();

    const cases = ["http://127.0.0.1/test", "http://[::ffff:127.0.0.1]/"] as const;
    for (const url of cases) {
      await expectBlockedUrl(tool, url, /private|internal|blocked/i);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it("blocks when DNS resolves to private addresses", async () => {
    lookupMock.mockImplementation(async (hostname: string) => {
      if (hostname === "public.test") {
        return [{ address: "93.184.216.34", family: 4 }];
      }
      return [{ address: "10.0.0.5", family: 4 }];
    });

    const fetchSpy = setMockFetch();
    const tool = createWebFetchToolForTest();

    await expectBlockedUrl(tool, "https://private.test/resource", /private|internal|blocked/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("blocks redirects to private hosts", async () => {
    // Redirect targets are new network destinations and must be re-checked
    // against the same SSRF policy as the original URL.
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);

    const fetchSpy = setMockFetch().mockResolvedValueOnce(
      redirectResponse("http://127.0.0.1/secret"),
    );
    const tool = createWebFetchToolForTest({
      firecrawlApiKey: "firecrawl-test", // pragma: allowlist secret
    });

    await expectBlockedUrl(tool, "https://example.com", /private|internal|blocked/i);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("supports exact and subdomain-only wildcard hostname allowlist entries", async () => {
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    const fetchSpy = setMockFetch().mockResolvedValue(textResponse("allowed"));
    const tool = createWebFetchToolForTest({
      ssrfPolicy: {
        hostnameAllowlist: [" ALLOWED.EXAMPLE. ", "*.trusted.example."],
      },
    });

    await tool?.execute?.("exact", { url: "https://allowed.example/page" });
    await tool?.execute?.("wildcard", { url: "https://cdn.trusted.example/page" });
    await expectBlockedUrl(tool, "https://trusted.example/page", /allowlist/i);

    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("blocks an initial hostname outside the configured allowlist", async () => {
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    const fetchSpy = setMockFetch();
    const tool = createWebFetchToolForTest({
      ssrfPolicy: { hostnameAllowlist: ["allowed.example"] },
    });

    await expectBlockedUrl(tool, "https://blocked.example/page", /allowlist/i);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it("logs an initial allowlist block once without URL secrets", async () => {
    const fetchSpy = setMockFetch();
    const tool = createWebFetchToolForTest({
      ssrfPolicy: { hostnameAllowlist: ["allowed.example"] },
    });

    await expectBlockedUrl(
      tool,
      "https://user:password@blocked.example/private/path?token=secret#fragment",
      /allowlist/i,
    );

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(logWarnMock).toHaveBeenCalledTimes(1);
    const warning = String(logWarnMock.mock.calls[0]?.[0] ?? "");
    expect(warning).toContain(
      "security: blocked URL fetch (url-fetch) targetOrigin=https://blocked.example",
    );
    expect(warning).not.toContain("user");
    expect(warning).not.toContain("password");
    expect(warning).not.toContain("/private/path");
    expect(warning).not.toContain("token=secret");
    expect(warning).not.toContain("#fragment");
  });

  it("re-applies the hostname allowlist to every redirect", async () => {
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    const fetchSpy = setMockFetch().mockResolvedValueOnce(
      redirectResponse("https://blocked.example/secret"),
    );
    const tool = createWebFetchToolForTest({
      ssrfPolicy: { hostnameAllowlist: ["allowed.example"] },
    });

    await expectBlockedUrl(tool, "https://allowed.example/start", /allowlist/i);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(lookupMock).toHaveBeenCalledTimes(1);
  });

  it("does not let a permissive cache entry bypass a later hostname allowlist", async () => {
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    const fetchSpy = setMockFetch().mockResolvedValue(textResponse("cached body"));
    const url = "https://cache-policy.example/page";

    const permissiveTool = createWebFetchToolForTest({ cacheTtlMinutes: 1 });
    await permissiveTool?.execute?.("permissive", { url });

    const restrictiveTool = createWebFetchToolForTest({
      cacheTtlMinutes: 1,
      ssrfPolicy: { hostnameAllowlist: ["allowed.example"] },
    });
    await expectBlockedUrl(restrictiveTool, url, /allowlist/i);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("isolates cache entries across different restrictive hostname policies", async () => {
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    const fetchSpy = setMockFetch()
      .mockResolvedValueOnce(textResponse("exact policy"))
      .mockResolvedValueOnce(textResponse("wildcard policy"));
    const url = "https://cache.allowed.example/page";

    const exactTool = createWebFetchToolForTest({
      cacheTtlMinutes: 1,
      ssrfPolicy: { hostnameAllowlist: ["cache.allowed.example"] },
    });
    await exactTool?.execute?.("exact-policy", { url });

    const wildcardTool = createWebFetchToolForTest({
      cacheTtlMinutes: 1,
      ssrfPolicy: { hostnameAllowlist: ["*.allowed.example"] },
    });
    const result = await wildcardTool?.execute?.("wildcard-policy", { url });

    expect((result?.details as { cached?: boolean } | undefined)?.cached).toBeUndefined();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("revalidates the hostname policy before returning a cache hit", async () => {
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    const fetchSpy = setMockFetch().mockResolvedValue(textResponse("cached policy body"));
    const assertPolicySpy = vi.spyOn(ssrf, "assertHostnameAllowedWithPolicy");
    const tool = createWebFetchToolForTest({
      cacheTtlMinutes: 1,
      ssrfPolicy: { hostnameAllowlist: ["cache-hit.example"] },
    });

    await tool?.execute?.("prime-cache", { url: "https://cache-hit.example/page" });
    assertPolicySpy.mockClear();
    const cached = await tool?.execute?.("read-cache", {
      url: "https://cache-hit.example/page",
    });

    expect((cached?.details as { cached?: boolean } | undefined)?.cached).toBe(true);
    expect(assertPolicySpy).toHaveBeenCalledExactlyOnceWith("cache-hit.example", {
      hostnameAllowlist: ["cache-hit.example"],
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("allows public hosts", async () => {
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);

    setMockFetch().mockResolvedValue(textResponse("ok"));
    const tool = createWebFetchToolForTest();

    const result = await tool?.execute?.("call", { url: "https://example.com" });
    expectRawFetchSuccessDetails(result?.details);
  });

  it("preserves trailing Unicode URL text through tool argument parsing", async () => {
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    const fetchSpy = setMockFetch().mockResolvedValue(textResponse("ok"));
    const tool = createWebFetchToolForTest();

    await tool?.execute?.("call", { url: "https://example.com/a\u00a0" });

    expect(firstFetchUrl(fetchSpy)).toBe("https://example.com/a%C2%A0");
  });

  it("trims leading Unicode whitespace through tool argument parsing", async () => {
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    const fetchSpy = setMockFetch().mockResolvedValue(textResponse("ok"));
    const tool = createWebFetchToolForTest();

    await tool?.execute?.("call", { url: "\u00a0\ufeffhttps://example.com" });

    expect(firstFetchUrl(fetchSpy)).toBe("https://example.com/");
  });

  it("trims trailing Unicode whitespace after a bare authority", async () => {
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    const fetchSpy = setMockFetch().mockResolvedValue(textResponse("ok"));
    const tool = createWebFetchToolForTest();

    await tool?.execute?.("call", { url: "https://example.com\u2003" });

    expect(firstFetchUrl(fetchSpy)).toBe("https://example.com/");
  });

  it("allows RFC2544 benchmark-range URLs only when web_fetch ssrfPolicy opts in", async () => {
    // Benchmark ranges are fake-IP infrastructure in some deployments, but
    // remain denied unless the web_fetch config opts in.
    const url = "http://198.18.0.153/file";
    lookupMock.mockResolvedValue([{ address: "198.18.0.153", family: 4 }]);

    const deniedTool = createWebFetchToolForTest({ cacheTtlMinutes: 1 });
    await expectBlockedUrl(deniedTool, url, /private|internal|blocked/i);

    const fetchSpy = setMockFetch().mockResolvedValue(textResponse("benchmark ok"));
    const allowedTool = createWebFetchToolForTest({
      ssrfPolicy: { allowRfc2544BenchmarkRange: true },
      cacheTtlMinutes: 1,
    });

    const allowed = await allowedTool?.execute?.("call", { url });
    expectRawFetchSuccessDetails(allowed?.details);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const stricterTool = createWebFetchToolForTest({ cacheTtlMinutes: 1 });
    await expectBlockedUrl(stricterTool, url, /private|internal|blocked/i);
  });

  it("allows IPv6 unique-local DNS answers only when web_fetch ssrfPolicy opts in", async () => {
    const url = "https://fake-ip.test/file";
    lookupMock.mockResolvedValue([{ address: "fc00::153", family: 6 }]);

    const deniedTool = createWebFetchToolForTest({ cacheTtlMinutes: 1 });
    await expectBlockedUrl(deniedTool, url, /private|internal|blocked/i);

    const fetchSpy = setMockFetch().mockResolvedValue(textResponse("ipv6 ula ok"));
    const allowedTool = createWebFetchToolForTest({
      ssrfPolicy: { allowIpv6UniqueLocalRange: true },
      cacheTtlMinutes: 1,
    });

    const allowed = await allowedTool?.execute?.("call", { url });
    expectRawFetchSuccessDetails(allowed?.details);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    const stricterTool = createWebFetchToolForTest({ cacheTtlMinutes: 1 });
    await expectBlockedUrl(stricterTool, url, /private|internal|blocked/i);
  });

  it("still blocks dangerous hostnames when trusted env proxy is explicitly enabled", async () => {
    vi.stubEnv("HTTP_PROXY", "http://127.0.0.1:7890");
    vi.stubEnv("http_proxy", "http://127.0.0.1:7890");
    const fetchSpy = setMockFetch();
    const tool = createWebFetchToolForTest({
      useTrustedEnvProxy: true,
      cacheTtlMinutes: 1,
    });

    await expectBlockedUrl(tool, "http://localhost/test", /Blocked hostname/i);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(lookupMock).not.toHaveBeenCalled();
  });
});
