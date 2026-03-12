import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as ssrf from "../../infra/net/ssrf.js";
import { withFetchPreconnect } from "../../test-utils/fetch-mock.js";
import { __testing as fetchInternals } from "./web-fetch.js";
import { __testing as searchInternals } from "./web-search.js";
import { createWebFetchTool } from "./web-tools.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeHeaders(map: Record<string, string>): { get: (key: string) => string | null } {
  return {
    get: (key) => map[key.toLowerCase()] ?? null,
  };
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  if ("url" in input && typeof input.url === "string") {
    return input.url;
  }
  return "";
}

function installMockFetch(
  impl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
) {
  const mockFetch = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => await impl(input, init),
  );
  global.fetch = withFetchPreconnect(mockFetch);
  return mockFetch;
}

function createFetchTool(fetchOverrides: Record<string, unknown> = {}) {
  return createWebFetchTool({
    config: {
      tools: {
        web: {
          fetch: {
            cacheTtlMinutes: 0,
            ...fetchOverrides,
          },
        },
      },
    },
    sandboxed: false,
  });
}

// ---------------------------------------------------------------------------
// web_fetch provider resolution
// ---------------------------------------------------------------------------

describe("resolveFetchProvider", () => {
  const { resolveFetchProvider } = fetchInternals;

  it("returns readability by default", () => {
    expect(resolveFetchProvider({ firecrawlEnabled: false })).toBe("readability");
  });

  it("returns explicit firecrawl provider", () => {
    expect(
      resolveFetchProvider({
        fetch: { provider: "firecrawl" } as Record<string, unknown>,
        firecrawlEnabled: false,
      }),
    ).toBe("firecrawl");
  });

  it("returns explicit scrapingbee provider", () => {
    expect(
      resolveFetchProvider({
        fetch: { provider: "scrapingbee" } as Record<string, unknown>,
        firecrawlEnabled: false,
      }),
    ).toBe("scrapingbee");
  });

  it("returns explicit readability provider", () => {
    expect(
      resolveFetchProvider({
        fetch: { provider: "readability" } as Record<string, unknown>,
        firecrawlEnabled: true,
      }),
    ).toBe("readability");
  });

  it("falls back to firecrawl when firecrawl.enabled is true and firecrawlEnabled", () => {
    expect(
      resolveFetchProvider({
        fetch: { firecrawl: { enabled: true } } as Record<string, unknown>,
        firecrawlEnabled: true,
      }),
    ).toBe("firecrawl");
  });
});

// ---------------------------------------------------------------------------
// ScrapingBee config resolution
// ---------------------------------------------------------------------------

describe("ScrapingBee config resolution", () => {
  const { resolveScrapingBeeConfig, resolveScrapingBeeApiKey, resolveScrapingBeeRenderJs } =
    fetchInternals;

  it("returns undefined for missing fetch config", () => {
    expect(resolveScrapingBeeConfig(undefined)).toBeUndefined();
  });

  it("extracts scrapingbee sub-config", () => {
    const config = resolveScrapingBeeConfig({
      scrapingbee: { apiKey: "sb-test", renderJs: true },
    } as Record<string, unknown>);
    expect(config).toMatchObject({ apiKey: "sb-test", renderJs: true });
  });

  it("resolves API key from config", () => {
    expect(resolveScrapingBeeApiKey({ apiKey: "sb-key-123" })).toBe("sb-key-123");
  });

  it("resolves API key from env var", () => {
    const original = process.env.SCRAPINGBEE_API_KEY;
    process.env.SCRAPINGBEE_API_KEY = "sb-env-key";
    try {
      expect(resolveScrapingBeeApiKey({})).toBe("sb-env-key");
    } finally {
      if (original === undefined) {
        delete process.env.SCRAPINGBEE_API_KEY;
      } else {
        process.env.SCRAPINGBEE_API_KEY = original;
      }
    }
  });

  it("defaults renderJs to false", () => {
    expect(resolveScrapingBeeRenderJs(undefined)).toBe(false);
    expect(resolveScrapingBeeRenderJs({})).toBe(false);
  });

  it("respects renderJs: true", () => {
    expect(resolveScrapingBeeRenderJs({ renderJs: true })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Firecrawl search provider resolution
// ---------------------------------------------------------------------------

describe("Firecrawl search provider resolution", () => {
  const { resolveFirecrawlSearchApiKey, resolveFirecrawlSearchBaseUrl } = searchInternals;

  it("resolves API key from config", () => {
    expect(resolveFirecrawlSearchApiKey({ apiKey: "fc-search-key" })).toBe("fc-search-key");
  });

  it("resolves API key from env var", () => {
    const original = process.env.FIRECRAWL_API_KEY;
    process.env.FIRECRAWL_API_KEY = "fc-env-key";
    try {
      expect(resolveFirecrawlSearchApiKey({})).toBe("fc-env-key");
    } finally {
      if (original === undefined) {
        delete process.env.FIRECRAWL_API_KEY;
      } else {
        process.env.FIRECRAWL_API_KEY = original;
      }
    }
  });

  it("returns default base URL when not configured", () => {
    expect(resolveFirecrawlSearchBaseUrl(undefined)).toBe("https://api.firecrawl.dev");
  });

  it("uses custom base URL from config", () => {
    expect(resolveFirecrawlSearchBaseUrl({ baseUrl: "https://custom.firecrawl.dev" })).toBe(
      "https://custom.firecrawl.dev",
    );
  });
});

// ---------------------------------------------------------------------------
// ScrapingBee execution path (provider: "scrapingbee")
// ---------------------------------------------------------------------------

describe("web_fetch with scrapingbee provider", () => {
  const priorFetch = global.fetch;

  beforeEach(() => {
    vi.spyOn(ssrf, "resolvePinnedHostname").mockImplementation(async (hostname) => {
      const normalized = hostname.trim().toLowerCase().replace(/\.$/, "");
      const addresses = ["93.184.216.34"];
      return {
        hostname: normalized,
        addresses,
        lookup: ssrf.createPinnedLookup({ hostname: normalized, addresses }),
      };
    });
  });

  afterEach(() => {
    global.fetch = priorFetch;
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("routes through ScrapingBee API and extracts via Readability", async () => {
    const apiKeyField = ["api", "Key"].join("");
    const mockFetch = installMockFetch((input: RequestInfo | URL) => {
      const url = requestUrl(input);
      if (url.includes("app.scrapingbee.com")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          url,
          headers: makeHeaders({
            "content-type": "text/html",
            "spb-resolved-url": "https://example.com/resolved",
          }),
          text: async () =>
            "<html><head><title>SB Page</title></head><body><article><p>ScrapingBee content here</p></article></body></html>",
        } as Response);
      }
      return Promise.reject(new Error("unexpected fetch"));
    });

    const tool = createFetchTool({
      provider: "scrapingbee",
      scrapingbee: { [apiKeyField]: "sb-test-key" },
    });

    const result = await tool?.execute?.("call", { url: "https://example.com/page" });
    const details = result?.details as { extractor?: string; text?: string };
    expect(details.extractor).toBe("scrapingbee+readability");
    expect(details.text).toContain("ScrapingBee content here");

    // Verify the ScrapingBee API was called with correct params
    const sbCall = mockFetch.mock.calls.find((call) =>
      requestUrl(call[0]).includes("scrapingbee.com"),
    );
    expect(sbCall).toBeTruthy();
    const sbUrl = new URL(requestUrl(sbCall![0]));
    expect(sbUrl.searchParams.get("api_key")).toBe("sb-test-key");
    expect(sbUrl.searchParams.get("url")).toBe("https://example.com/page");
  });

  it("falls back to direct fetch when ScrapingBee fails", async () => {
    const apiKeyField = ["api", "Key"].join("");
    installMockFetch((input: RequestInfo | URL) => {
      const url = requestUrl(input);
      if (url.includes("app.scrapingbee.com")) {
        return Promise.resolve({
          ok: false,
          status: 500,
          text: async () => "internal error",
        } as Response);
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        url,
        headers: makeHeaders({ "content-type": "text/html" }),
        text: async () =>
          "<html><head><title>Direct</title></head><body><article><p>Direct fetch content</p></article></body></html>",
      } as Response);
    });

    const tool = createFetchTool({
      provider: "scrapingbee",
      scrapingbee: { [apiKeyField]: "sb-test-key" },
    });

    const result = await tool?.execute?.("call", { url: "https://example.com/fallback" });
    const details = result?.details as { extractor?: string; text?: string };
    expect(details.text).toContain("Direct fetch content");
  });

  it("sends render_js param when configured", async () => {
    const apiKeyField = ["api", "Key"].join("");
    const mockFetch = installMockFetch((input: RequestInfo | URL) => {
      const url = requestUrl(input);
      if (url.includes("app.scrapingbee.com")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          url,
          headers: makeHeaders({ "content-type": "text/html" }),
          text: async () => "<html><body><article><p>JS rendered</p></article></body></html>",
        } as Response);
      }
      return Promise.reject(new Error("unexpected fetch"));
    });

    const tool = createFetchTool({
      provider: "scrapingbee",
      scrapingbee: { [apiKeyField]: "sb-test-key", renderJs: true },
    });

    await tool?.execute?.("call", { url: "https://example.com/js" });

    const sbCall = mockFetch.mock.calls.find((call) =>
      requestUrl(call[0]).includes("scrapingbee.com"),
    );
    const sbUrl = new URL(requestUrl(sbCall![0]));
    expect(sbUrl.searchParams.get("render_js")).toBe("true");
  });
});

// ---------------------------------------------------------------------------
// web_fetch with firecrawl as primary provider
// ---------------------------------------------------------------------------

describe("web_fetch with firecrawl as primary provider", () => {
  const priorFetch = global.fetch;
  const apiKeyField = ["api", "Key"].join("");

  beforeEach(() => {
    vi.spyOn(ssrf, "resolvePinnedHostname").mockImplementation(async (hostname) => {
      const normalized = hostname.trim().toLowerCase().replace(/\.$/, "");
      const addresses = ["93.184.216.34"];
      return {
        hostname: normalized,
        addresses,
        lookup: ssrf.createPinnedLookup({ hostname: normalized, addresses }),
      };
    });
  });

  afterEach(() => {
    global.fetch = priorFetch;
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("uses firecrawl as primary extractor when provider is firecrawl", async () => {
    installMockFetch((input: RequestInfo | URL) => {
      const url = requestUrl(input);
      if (url.includes("api.firecrawl.dev")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            success: true,
            data: {
              markdown: "Firecrawl primary content",
              metadata: { title: "FC", sourceURL: url, statusCode: 200 },
            },
          }),
        } as Response);
      }
      return Promise.reject(new Error("should not direct-fetch when firecrawl is primary"));
    });

    const tool = createFetchTool({
      provider: "firecrawl",
      firecrawl: { [apiKeyField]: "fc-test-key" },
    });

    const result = await tool?.execute?.("call", { url: "https://example.com/fc" });
    const details = result?.details as { extractor?: string; text?: string };
    expect(details.extractor).toBe("firecrawl");
    expect(details.text).toContain("Firecrawl primary content");
  });
});
