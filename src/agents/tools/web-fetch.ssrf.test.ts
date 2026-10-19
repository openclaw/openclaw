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
            entries: { firecrawl: { config: { webFetch: { apiKey: params.firecrawlApiKey } } } },
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

async function expectSuccess(tool: ReturnType<typeof createWebFetchToolForTest>, url: string) {
  const result = await tool?.execute?.("call", { url });
  expect(result?.details).toMatchObject({ status: 200, extractor: "raw" });
  return result;
}

describe("web_fetch SSRF protection", () => {
  const priorFetch = global.fetch;

  beforeEach(() => {
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
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

    for (const url of ["http://127.0.0.1/test", "http://[::ffff:127.0.0.1]/"]) {
      await expectBlockedUrl(tool, url, /private|internal|blocked/i);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it("allows loopback with an explicit private-network opt-in", async () => {
    lookupMock.mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
    const fetchSpy = setMockFetch().mockResolvedValue(textResponse("local ok"));
    const tool = createWebFetchToolForTest({
      ssrfPolicy: { dangerouslyAllowPrivateNetwork: true },
    });

    await expectSuccess(tool, "http://127.0.0.1/test");
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it("blocks when DNS resolves to private addresses", async () => {
    lookupMock.mockResolvedValue([{ address: "10.0.0.5", family: 4 }]);

    const fetchSpy = setMockFetch();
    const tool = createWebFetchToolForTest();

    await expectBlockedUrl(tool, "https://private.test/resource", /private|internal|blocked/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("blocks redirects to private hosts", async () => {
    const fetchSpy = setMockFetch().mockResolvedValueOnce(
      redirectResponse("http://127.0.0.1/secret"),
    );
    const tool = createWebFetchToolForTest({
      firecrawlApiKey: "firecrawl-test", // pragma: allowlist secret
    });

    await expectBlockedUrl(tool, "https://example.com", /private|internal|blocked/i);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("blocks a turn-scoped domain-policy miss with recovery guidance", async () => {
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
    const fetchSpy = setMockFetch().mockResolvedValue(textResponse("permitted"));
    const tool = createWebFetchToolForTest({
      hostnameAllowlist: ["example.com", "*.example.com"],
    });

    await expectSuccess(tool, "https://example.com/");
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it("does not reuse an unrestricted cache entry across a domain policy", async () => {
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
    ["https:// docs.openclaw.ai", "https://docs.openclaw.ai", "https://docs.openclaw.ai/"],
    ["\u00a0\ufeffhttps://example.com", "https://example.com", "https://example.com/"],
    ["https://example.com\n", "https://example.com", "https://example.com/"],
    ["https://example.com/a\u00a0", "https://example.com/a\u00a0", "https://example.com/a%C2%A0"],
    ["https://example.com\u00a0", "https://example.com", "https://example.com/"],
  ])("normalizes %j through web_fetch", async (input, expectedUrl, expectedFetchUrl) => {
    const fetchSpy = setMockFetch().mockResolvedValue(
      new Response("ok", { headers: { "content-type": "text/plain" } }),
    );
    const tool = createWebFetchToolForTest();

    const result = await expectSuccess(tool, input);
    expect(result?.details).toMatchObject({ url: expectedUrl });
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(firstFetchUrl(fetchSpy)).toBe(expectedFetchUrl);
  });

  it.each<[string, string, number, ssrf.SsrFPolicy]>([
    ["http://198.18.0.153/file", "198.18.0.153", 4, { allowRfc2544BenchmarkRange: true }],
    ["https://fake-ip.test/file", "fc00::153", 6, { allowIpv6UniqueLocalRange: true }],
  ])(
    "requires ssrfPolicy opt-in for %s, including cache hits",
    async (url, address, family, ssrfPolicy) => {
      lookupMock.mockResolvedValue([{ address, family }]);
      const strict = () => createWebFetchToolForTest({ cacheTtlMinutes: 1 });
      await expectBlockedUrl(strict(), url, /private|internal|blocked/i);
      const fetchSpy = setMockFetch().mockResolvedValue(textResponse("allowed"));
      await expectSuccess(createWebFetchToolForTest({ ssrfPolicy, cacheTtlMinutes: 1 }), url);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      await expectBlockedUrl(strict(), url, /private|internal|blocked/i);
    },
  );

  it("still blocks dangerous hostnames when trusted env proxy is explicitly enabled", async () => {
    vi.stubEnv("HTTP_PROXY", "http://127.0.0.1:7890");
    vi.stubEnv("http_proxy", "http://127.0.0.1:7890");
    const fetchSpy = setMockFetch();
    const tool = createWebFetchToolForTest({ useTrustedEnvProxy: true, cacheTtlMinutes: 1 });

    await expectBlockedUrl(tool, "http://localhost/test", /Blocked hostname/i);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(lookupMock).not.toHaveBeenCalled();
  });
});
