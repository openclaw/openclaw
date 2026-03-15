import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as ssrf from "../../infra/net/ssrf.js";
import { type FetchMock, withFetchPreconnect } from "../../test-utils/fetch-mock.js";
import { makeFetchHeaders } from "./web-fetch.test-harness.js";

const lookupMock = vi.fn();
const resolvePinnedHostname = ssrf.resolvePinnedHostname;
const resolvePinnedHostnameWithPolicy = ssrf.resolvePinnedHostnameWithPolicy;

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
  const fetchSpy = vi.fn<FetchMock>(impl);
  global.fetch = withFetchPreconnect(fetchSpy);
  return fetchSpy;
}

async function createWebFetchToolForTest(params?: {
  firecrawl?: { enabled?: boolean; apiKey?: string };
  ssrfPolicy?: ssrf.SsrFPolicy;
}) {
  const { createWebFetchTool } = await import("./web-tools.js");

  // Build config with ssrfPolicy injected via tools.web.fetch.ssrfPolicy
  const fetchConfig: Record<string, unknown> = {
    cacheTtlMinutes: 0,
    firecrawl: params?.firecrawl ?? { enabled: false },
  };

  // Inject ssrfPolicy via config key if provided
  if (params?.ssrfPolicy) {
    fetchConfig.ssrfPolicy = params.ssrfPolicy;
  }

  return createWebFetchTool({
    config: {
      tools: {
        web: {
          fetch: fetchConfig,
        },
      },
    },
  });
}

async function expectBlockedUrl(
  tool: Awaited<ReturnType<typeof createWebFetchToolForTest>>,
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
    vi.spyOn(ssrf, "resolvePinnedHostnameWithPolicy").mockImplementation((hostname, params) =>
      resolvePinnedHostnameWithPolicy(hostname, {
        ...params,
        lookupFn: lookupMock,
      }),
    );
  });

  afterEach(() => {
    global.fetch = priorFetch;
    lookupMock.mockClear();
    vi.restoreAllMocks();
  });

  it("blocks localhost hostnames before fetch/firecrawl", async () => {
    const fetchSpy = setMockFetch();
    const tool = await createWebFetchToolForTest({
      firecrawl: { apiKey: "firecrawl-test" }, // pragma: allowlist secret
    });

    await expectBlockedUrl(tool, "http://localhost/test", /Blocked hostname/i);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it("blocks private IP literals without DNS", async () => {
    const fetchSpy = setMockFetch();
    const tool = await createWebFetchToolForTest();

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
    const tool = await createWebFetchToolForTest();

    await expectBlockedUrl(tool, "https://private.test/resource", /private|internal|blocked/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("blocks redirects to private hosts", async () => {
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);

    const fetchSpy = setMockFetch().mockResolvedValueOnce(
      redirectResponse("http://127.0.0.1/secret"),
    );
    const tool = await createWebFetchToolForTest({
      firecrawl: { apiKey: "firecrawl-test" }, // pragma: allowlist secret
    });

    await expectBlockedUrl(tool, "https://example.com", /private|internal|blocked/i);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("allows public hosts", async () => {
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);

    setMockFetch().mockResolvedValue(textResponse("ok"));
    const tool = await createWebFetchToolForTest();

    const result = await tool?.execute?.("call", { url: "https://example.com" });
    expect(result?.details).toMatchObject({
      status: 200,
      extractor: "raw",
    });
  });

  it("allows private IP when allowPrivateNetwork is true (via config)", async () => {
    setMockFetch().mockResolvedValue(textResponse("ok"));
    lookupMock.mockResolvedValue([{ address: "192.168.1.1", family: 4 }]);
    const tool = await createWebFetchToolForTest({
      ssrfPolicy: { allowPrivateNetwork: true },
    });

    await expect(tool?.execute?.("call", { url: "http://192.168.1.1" })).resolves.toBeDefined();
  });

  it("allows whitelisted hostnames (via config)", async () => {
    setMockFetch().mockResolvedValue(textResponse("ok"));
    lookupMock.mockResolvedValue([{ address: "192.168.1.1", family: 4 }]);
    const tool = await createWebFetchToolForTest({
      ssrfPolicy: { allowedHostnames: ["192.168.1.1"] },
    });

    await expect(tool?.execute?.("call", { url: "http://192.168.1.1" })).resolves.toBeDefined();
  });

  it("cache key differentiates between different SSRF policies", async () => {
    const { createWebFetchTool } = await import("./web-tools.js");

    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);

    const testUrl = "https://example.com/page";
    let callCount = 0;
    setMockFetch().mockImplementation(async () => {
      callCount++;
      return textResponse(`response-${callCount}`);
    });

    // Create tool with caching ENABLED (non-zero cacheTtlMinutes)
    const createTool = (ssrfPolicy?: ssrf.SsrFPolicy) => {
      const fetchConfig: Record<string, unknown> = {
        cacheTtlMinutes: 15, // Enable caching for this test
        firecrawl: { enabled: false },
      };
      if (ssrfPolicy) {
        fetchConfig.ssrfPolicy = ssrfPolicy;
      }
      return createWebFetchTool({
        config: {
          tools: {
            web: {
              fetch: fetchConfig,
            },
          },
        },
      });
    };

    // First, fetch with no SSRF policy
    const toolNoPolicy = createTool();
    const result1 = await toolNoPolicy?.execute?.("call", { url: testUrl });
    expect(callCount).toBe(1);
    expect(result1?.details?.text).toContain("response-1");

    // Fetch the same URL with a different SSRF policy
    // This should NOT hit the cache from the first call, creating a new fetch
    const toolWithPolicy = createTool({ allowPrivateNetwork: true });
    const result2 = await toolWithPolicy?.execute?.("call", { url: testUrl });
    expect(callCount).toBe(2); // Should have called fetch again, not used cache
    expect(result2?.details?.text).toContain("response-2");

    // Verify different policies produce different results due to separate cache entries
    expect(result1?.details?.text).not.toEqual(result2?.details?.text);
  });
});
