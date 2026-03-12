import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as ssrf from "../../infra/net/ssrf.js";
import { type FetchMock, withFetchPreconnect } from "../../test-utils/fetch-mock.js";

const lookupMock = vi.fn();
const resolvePinnedHostnameWithPolicy = ssrf.resolvePinnedHostnameWithPolicy;

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

function htmlResponse(body: string): Response {
  return {
    ok: true,
    status: 200,
    headers: makeHeaders({ "content-type": "text/html; charset=utf-8" }),
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
    dangerouslyAllowPrivateNetwork?: boolean;
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
            ...(params?.ssrfPolicy ? { ssrfPolicy: params.ssrfPolicy } : {}),
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
    vi.spyOn(ssrf, "resolvePinnedHostnameWithPolicy").mockImplementation((hostname, params = {}) =>
      resolvePinnedHostnameWithPolicy(hostname, { ...params, lookupFn: lookupMock }),
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

  it("allows explicitly configured blocked hostnames", async () => {
    setMockFetch().mockResolvedValue(textResponse("ok"));
    const tool = await createWebFetchToolForTest({
      ssrfPolicy: { allowedHostnames: ["localhost"] },
    });

    const result = await tool?.execute?.("call", { url: "http://localhost/test" });
    expect(result?.details).toMatchObject({
      status: 200,
      extractor: "raw",
    });
  });

  it("does not forward relaxed private URLs to Firecrawl", async () => {
    lookupMock.mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);

    const fetchSpy = setMockFetch().mockResolvedValue(htmlResponse("<html><body> </body></html>"));
    const tool = await createWebFetchToolForTest({
      firecrawl: { apiKey: "firecrawl-test" }, // pragma: allowlist secret
      ssrfPolicy: { allowedHostnames: ["localhost"] },
    });

    await expect(tool?.execute?.("call", { url: "http://localhost/empty" })).rejects.toThrow(
      /Readability and Firecrawl returned no content/i,
    );
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("forwards to Firecrawl for public hostnames when the active policy allows special local resolution", async () => {
    lookupMock.mockResolvedValue([{ address: "10.0.0.5", family: 4 }]);

    const fetchSpy = setMockFetch().mockResolvedValue(htmlResponse("<html><body> </body></html>"));
    const tool = await createWebFetchToolForTest({
      firecrawl: { apiKey: "firecrawl-test" },
      ssrfPolicy: { dangerouslyAllowPrivateNetwork: true },
    });

    await expect(tool?.execute?.("call", { url: "http://example.com/empty" })).rejects.toThrow(
      /Readability and Firecrawl returned no content/i,
    );
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("does not forward hostname-based local exceptions to Firecrawl", async () => {
    lookupMock.mockResolvedValue([{ address: "10.0.0.5", family: 4 }]);

    const fetchSpy = setMockFetch().mockResolvedValue(htmlResponse("<html><body> </body></html>"));
    const tool = await createWebFetchToolForTest({
      firecrawl: { apiKey: "firecrawl-test" },
      ssrfPolicy: { allowedHostnames: ["internal.test"] },
    });

    await expect(tool?.execute?.("call", { url: "http://internal.test/empty" })).rejects.toThrow(
      /Readability and Firecrawl returned no content/i,
    );
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("does not suppress Firecrawl for unrelated public hostnames when local exceptions are configured", async () => {
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);

    const fetchSpy = setMockFetch().mockResolvedValue(htmlResponse("<html><body> </body></html>"));
    const tool = await createWebFetchToolForTest({
      firecrawl: { apiKey: "firecrawl-test" },
      ssrfPolicy: { allowedHostnames: ["localhost"] },
    });

    await expect(tool?.execute?.("call", { url: "https://example.com/empty" })).rejects.toThrow(
      /Readability and Firecrawl returned no content/i,
    );
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("does not forward to Firecrawl when DNS verification fails", async () => {
    vi.spyOn(ssrf, "resolvePinnedHostnameWithPolicy")
      .mockImplementationOnce(
        async (_hostname, params = {}) =>
          ({
            hostname: "example.com",
            addresses: ["10.0.0.5"],
            lookup: params.lookupFn ?? lookupMock,
          }) as unknown as Awaited<ReturnType<typeof resolvePinnedHostnameWithPolicy>>,
      )
      .mockImplementationOnce(async () => {
        throw new Error("dns timeout");
      });

    const fetchSpy = setMockFetch().mockResolvedValue(htmlResponse("<html><body> </body></html>"));
    const tool = await createWebFetchToolForTest({
      firecrawl: { apiKey: "firecrawl-test" },
      ssrfPolicy: { dangerouslyAllowPrivateNetwork: true },
    });

    await expect(tool?.execute?.("call", { url: "http://example.com/empty" })).rejects.toThrow(
      /Readability and Firecrawl returned no content/i,
    );
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("isolates cache entries across SSRF policies", async () => {
    const fetchSpy = setMockFetch().mockResolvedValue(textResponse("ok-from-localhost"));
    const permissiveTool = await createWebFetchToolForTest({
      ssrfPolicy: { allowedHostnames: ["localhost"] },
    });
    const strictTool = await createWebFetchToolForTest();

    const permissiveResult = await permissiveTool?.execute?.("call", {
      url: "http://localhost/test",
    });
    expect(permissiveResult?.details).toMatchObject({
      status: 200,
      extractor: "raw",
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    await expect(strictTool?.execute?.("call", { url: "http://localhost/test" })).rejects.toThrow(
      /Blocked hostname/i,
    );
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
});
