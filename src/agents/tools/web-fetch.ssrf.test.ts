import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as ssrf from "../../infra/net/ssrf.js";
import { type FetchMock, withFetchPreconnect } from "../../test-utils/fetch-mock.js";

const lookupMock = vi.fn();
const resolvePinnedHostname = ssrf.resolvePinnedHostname;

function makeHeaders(map: Record<string, string>): { get: (key: string) => string | null } {
  return {
    get: (key) => map[key.toLowerCase()] ?? null,
  };
}

function redirectResponse(location: string): Response {
  return {
    ok: false,
    status: 302,
    headers: makeHeaders({ location }),
    body: { cancel: vi.fn() },
  } as unknown as Response;
}

function textResponse(body: string): Response {
  return {
    ok: true,
    status: 200,
    headers: makeHeaders({ "content-type": "text/plain" }),
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
  ssrfPolicy?: {
    allowPrivateNetwork?: boolean;
    dangerouslyAllowPrivateNetwork?: boolean;
    allowRfc2544BenchmarkRange?: boolean;
    allowedHostnames?: string[];
    hostnameAllowlist?: string[];
  };
}) {
  const { createWebFetchTool } = await import("./web-tools.js");
  return createWebFetchTool({
    config: {
      tools: {
        web: {
          fetch: {
            cacheTtlMinutes: 0,
            firecrawl: params?.firecrawl ?? { enabled: false },
            ssrfPolicy: params?.ssrfPolicy,
          },
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
  });

  afterEach(() => {
    global.fetch = priorFetch;
    lookupMock.mockClear();
    vi.restoreAllMocks();
  });

  it("blocks localhost hostnames before fetch/firecrawl", async () => {
    const fetchSpy = setMockFetch();
    const tool = await createWebFetchToolForTest({
      firecrawl: { apiKey: "firecrawl-test" },
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
      firecrawl: { apiKey: "firecrawl-test" },
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

  it("allows private IPs when dangerouslyAllowPrivateNetwork is set", async () => {
    // Mock resolvePinnedHostnameWithPolicy to return a private IP pinned result
    vi.spyOn(ssrf, "resolvePinnedHostnameWithPolicy").mockResolvedValue({
      hostname: "private.test",
      addresses: ["10.0.0.5"],
      lookup: (() => {}) as unknown as ReturnType<typeof ssrf.createPinnedLookup>,
    });

    setMockFetch().mockResolvedValue(textResponse("internal-ok"));
    const tool = await createWebFetchToolForTest({
      ssrfPolicy: { dangerouslyAllowPrivateNetwork: true },
    });

    const result = await tool?.execute?.("call", { url: "https://private.test/resource" });
    expect(result?.details).toMatchObject({
      status: 200,
    });
  });

  it("allows private IPs when legacy allowPrivateNetwork is set", async () => {
    vi.spyOn(ssrf, "resolvePinnedHostnameWithPolicy").mockResolvedValue({
      hostname: "local.test",
      addresses: ["192.168.1.1"],
      lookup: (() => {}) as unknown as ReturnType<typeof ssrf.createPinnedLookup>,
    });

    setMockFetch().mockResolvedValue(textResponse("internal-ok"));
    const tool = await createWebFetchToolForTest({
      ssrfPolicy: { allowPrivateNetwork: true },
    });

    const result = await tool?.execute?.("call", { url: "https://local.test/api" });
    expect(result?.details).toMatchObject({
      status: 200,
    });
  });

  it("allows RFC 2544 range when allowRfc2544BenchmarkRange is set", async () => {
    // 198.18.x.x is the Clash/mihomo fake-ip range
    vi.spyOn(ssrf, "resolvePinnedHostnameWithPolicy").mockResolvedValue({
      hostname: "clash-fake.test",
      addresses: ["198.18.0.42"],
      lookup: (() => {}) as unknown as ReturnType<typeof ssrf.createPinnedLookup>,
    });

    setMockFetch().mockResolvedValue(textResponse("fake-ip-ok"));
    const tool = await createWebFetchToolForTest({
      ssrfPolicy: { allowRfc2544BenchmarkRange: true },
    });

    const result = await tool?.execute?.("call", { url: "https://clash-fake.test/page" });
    expect(result?.details).toMatchObject({
      status: 200,
    });
  });

  it("blocks RFC 2544 range without allowRfc2544BenchmarkRange", async () => {
    // Without policy, resolvePinnedHostnameWithPolicy rejects the private IP
    vi.spyOn(ssrf, "resolvePinnedHostnameWithPolicy").mockRejectedValue(
      new ssrf.SsrFBlockedError("Blocked: resolves to private/internal/special-use IP address"),
    );

    setMockFetch();
    const tool = await createWebFetchToolForTest();

    await expectBlockedUrl(tool, "https://clash-fake.test/page", /private|internal|blocked/i);
  });

  it("still blocks private IPs without ssrfPolicy", async () => {
    vi.spyOn(ssrf, "resolvePinnedHostnameWithPolicy").mockRejectedValue(
      new ssrf.SsrFBlockedError("Blocked: resolves to private/internal/special-use IP address"),
    );

    setMockFetch();
    const tool = await createWebFetchToolForTest();

    await expectBlockedUrl(tool, "https://private.test/resource", /private|internal|blocked/i);
  });
});
