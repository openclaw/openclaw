// web_fetch SSRF tests cover URL, DNS, redirect, and proxy policy enforcement
// before network requests reach fetch or provider fallbacks.
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as ssrf from "../../infra/net/ssrf.js";
import { type FetchMock, withFetchPreconnect } from "../../test-utils/fetch-mock.js";
import { createWebFetchTool } from "./web-fetch.js";
import { makeFetchHeaders } from "./web-fetch.test-harness.js";
import "./web-fetch.test-mocks.js";

const lookupMock = vi.fn();
const resolvePinnedHostname = ssrf.resolvePinnedHostname;

function redirectResponse(location: string): Response {
  return {
    ok: false,
    status: 302,
    headers: makeFetchHeaders({ location }),
    body: { cancel: vi.fn(async () => undefined) },
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
  return expectDefined(
    input instanceof Request ? input.url : input instanceof URL ? input.href : input,
    "input instanceof Request ? input.url : input instanceof URL ? input.h... test invariant",
  );
}

function createWebFetchToolForTest(params?: {
  firecrawlApiKey?: string;
  useTrustedEnvProxy?: boolean;
  ssrfPolicy?: ssrf.SsrFPolicy;
  hostnameAllowlist?: string[];
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
    hostnameAllowlistRef: { value: params?.hostnameAllowlist },
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

  it.each([
    {
      name: "private-network opt-in",
      ssrfPolicy: { dangerouslyAllowPrivateNetwork: true },
    },
    {
      name: "exact hostname opt-in",
      ssrfPolicy: { allowedHostnames: ["127.0.0.1"] },
    },
  ])("allows loopback with an explicit $name", async ({ ssrfPolicy }) => {
    lookupMock.mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
    const fetchSpy = setMockFetch().mockResolvedValue(textResponse("local ok"));
    const tool = createWebFetchToolForTest({ ssrfPolicy });

    const result = await tool?.execute?.("call", { url: "http://127.0.0.1/test" });

    expectRawFetchSuccessDetails(result?.details);
    expect(fetchSpy).toHaveBeenCalledOnce();
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

  it("allows public hosts", async () => {
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);

    setMockFetch().mockResolvedValue(textResponse("ok"));
    const tool = createWebFetchToolForTest();

    const result = await tool?.execute?.("call", { url: "https://example.com" });
    expectRawFetchSuccessDetails(result?.details);
  });

  it("blocks a turn-scoped domain-policy miss with recovery guidance", async () => {
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    const fetchSpy = setMockFetch().mockResolvedValue(textResponse("not permitted"));
    const tool = createWebFetchToolForTest({
      hostnameAllowlist: ["example.com", "*.example.com"],
    });

    await expectBlockedUrl(
      tool,
      "https://www.nytimes.com/",
      /domain policy: blocked hostname.*example\.com.*Try a URL on a permitted domain/i,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it("allows a turn-scoped domain-policy match", async () => {
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    const fetchSpy = setMockFetch().mockResolvedValue(textResponse("permitted"));
    const tool = createWebFetchToolForTest({
      hostnameAllowlist: ["example.com", "*.example.com"],
    });

    const result = await tool?.execute?.("call", { url: "https://example.com/" });

    expectRawFetchSuccessDetails(result?.details);
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it("does not reuse an unrestricted cache entry across a domain policy", async () => {
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    const fetchSpy = setMockFetch().mockResolvedValue(textResponse("cached outside content"));
    const url = "https://outside.test/cached-policy-boundary";
    const unrestricted = createWebFetchToolForTest({ cacheTtlMinutes: 1 });
    await unrestricted?.execute?.("call", { url });
    const restricted = createWebFetchToolForTest({
      ssrfPolicy: { hostnameAllowlist: ["example.com", "*.example.com"] },
      cacheTtlMinutes: 1,
    });

    await expectBlockedUrl(
      restricted,
      url,
      /domain policy: blocked hostname.*example\.com.*Try a URL on a permitted domain/i,
    );
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it.each([
    {
      name: "removes whitespace between scheme and authority (reported bug)",
      input: "https:// docs.openclaw.ai",
      expectedUrl: "https://docs.openclaw.ai",
      expectedFetchUrl: "https://docs.openclaw.ai/",
    },
    {
      name: "trims leading and trailing whitespace",
      input: "  https://example.com  ",
      expectedUrl: "https://example.com",
      expectedFetchUrl: "https://example.com/",
    },
    {
      name: "trims leading Unicode whitespace",
      input: "\u00a0\ufeffhttps://example.com",
      expectedUrl: "https://example.com",
      expectedFetchUrl: "https://example.com/",
    },
    {
      name: "trims trailing newlines",
      input: "https://example.com\n",
      expectedUrl: "https://example.com",
      expectedFetchUrl: "https://example.com/",
    },
    {
      name: "preserves trailing Unicode whitespace in paths",
      input: "https://example.com/a\u00a0",
      expectedUrl: "https://example.com/a\u00a0",
      expectedFetchUrl: "https://example.com/a%C2%A0",
    },
    {
      name: "trims trailing Unicode whitespace after a bare authority",
      input: "https://example.com\u00a0",
      expectedUrl: "https://example.com",
      expectedFetchUrl: "https://example.com/",
    },
    {
      name: "preserves spaces in the path component",
      input: "https://example.com/a b",
      expectedUrl: "https://example.com/a b",
      expectedFetchUrl: "https://example.com/a%20b",
    },
    {
      name: "preserves spaces in the query component",
      input: "https://example.com?q=a b",
      expectedUrl: "https://example.com?q=a b",
      expectedFetchUrl: "https://example.com/?q=a%20b",
    },
    {
      name: "preserves scheme-like text in the path component",
      input: "https://example.com/a:// b",
      expectedUrl: "https://example.com/a:// b",
      expectedFetchUrl: "https://example.com/a://%20b",
    },
    {
      name: "preserves scheme-like text in the query component",
      input: "https://example.com?q=x:// y",
      expectedUrl: "https://example.com?q=x:// y",
      expectedFetchUrl: "https://example.com/?q=x://%20y",
    },
    {
      name: "preserves percent-encoded characters in path",
      input: "https://example.com/a%20b",
      expectedUrl: "https://example.com/a%20b",
      expectedFetchUrl: "https://example.com/a%20b",
    },
    {
      name: "does not modify already-valid URLs",
      input: "https://docs.openclaw.ai",
      expectedUrl: "https://docs.openclaw.ai",
      expectedFetchUrl: "https://docs.openclaw.ai/",
    },
    {
      name: "handles https:// with tab after scheme",
      input: "https://\texample.com",
      expectedUrl: "https://example.com",
      expectedFetchUrl: "https://example.com/",
    },
    {
      name: "trims trailing em-space after a bare authority",
      input: "https://example.com\u2003",
      expectedUrl: "https://example.com",
      expectedFetchUrl: "https://example.com/",
    },
  ])("$name through web_fetch", async ({ input, expectedUrl, expectedFetchUrl }) => {
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    const fetchSpy = setMockFetch().mockResolvedValue(
      new Response("ok", { headers: { "content-type": "text/plain" } }),
    );
    const tool = createWebFetchToolForTest();

    const result = await tool?.execute?.("call", { url: input });

    expect(result?.details).toMatchObject({ url: expectedUrl, status: 200, extractor: "raw" });
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(firstFetchUrl(fetchSpy)).toBe(expectedFetchUrl);
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
