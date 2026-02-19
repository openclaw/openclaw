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
}) {
  const { createWebFetchTool } = await import("./web-tools.js");
  return createWebFetchTool({
    config: {
      tools: {
        web: {
          fetch: {
            cacheTtlMinutes: 0,
            firecrawl: params?.firecrawl ?? { enabled: false },
          },
        },
      },
    },
  });
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
    lookupMock.mockReset();
    vi.restoreAllMocks();
  });

  it("blocks localhost hostnames before fetch/firecrawl", async () => {
    const fetchSpy = setMockFetch();
    const tool = await createWebFetchToolForTest({
      firecrawl: { apiKey: "firecrawl-test" },
    });

    await expect(tool?.execute?.("call", { url: "http://localhost/test" })).rejects.toThrow(
      /Blocked hostname/i,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it("blocks private IP literals without DNS", async () => {
    const fetchSpy = setMockFetch();
    const tool = await createWebFetchToolForTest();

    await expect(tool?.execute?.("call", { url: "http://127.0.0.1/test" })).rejects.toThrow(
      /private|internal|blocked/i,
    );
    await expect(tool?.execute?.("call", { url: "http://[::ffff:127.0.0.1]/" })).rejects.toThrow(
      /private|internal|blocked/i,
    );
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

    await expect(tool?.execute?.("call", { url: "https://private.test/resource" })).rejects.toThrow(
      /private|internal|blocked/i,
    );
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

    await expect(tool?.execute?.("call", { url: "https://example.com" })).rejects.toThrow(
      /private|internal|blocked/i,
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
