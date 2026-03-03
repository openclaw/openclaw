import { afterEach, describe, expect, it, vi } from "vitest";
import { withFetchPreconnect } from "../../test-utils/fetch-mock.js";
import { createFirecrawlScrapeTool, createFirecrawlSearchTool } from "./firecrawl-tools.js";

function installMockFetch(payload: unknown) {
  const mockFetch = vi.fn((_input?: unknown, _init?: unknown) =>
    Promise.resolve({
      ok: true,
      status: 200,
      statusText: "OK",
      json: () => Promise.resolve(payload),
    } as Response),
  );
  global.fetch = withFetchPreconnect(mockFetch);
  return mockFetch;
}

function configWithApiKey(apiKey: string) {
  return {
    config: {
      tools: {
        web: {
          fetch: {
            firecrawl: { apiKey },
          },
        },
      },
    },
  };
}

describe("firecrawl_search tool", () => {
  const priorFetch = global.fetch;

  afterEach(() => {
    vi.unstubAllEnvs();
    global.fetch = priorFetch;
  });

  it("returns null when no Firecrawl API key is present", () => {
    vi.stubEnv("FIRECRAWL_API_KEY", "");
    const tool = createFirecrawlSearchTool({ config: {} });
    expect(tool).toBeNull();
  });

  it("returns a tool when config API key is present", () => {
    const tool = createFirecrawlSearchTool(configWithApiKey("fc-test-key"));
    expect(tool).not.toBeNull();
    expect(tool?.name).toBe("firecrawl_search");
  });

  it("returns a tool when FIRECRAWL_API_KEY env var is set", () => {
    vi.stubEnv("FIRECRAWL_API_KEY", "fc-env-key");
    const tool = createFirecrawlSearchTool({ config: {} });
    expect(tool).not.toBeNull();
    expect(tool?.name).toBe("firecrawl_search");
  });

  it("calls POST /v2/search with correct payload", async () => {
    const mockFetch = installMockFetch({
      success: true,
      data: [
        {
          title: "Example",
          url: "https://example.com",
          description: "An example site",
        },
      ],
    });
    const tool = createFirecrawlSearchTool(configWithApiKey("fc-test-key"));
    await tool?.execute?.("call-1", { query: "test query", limit: 3 });

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.firecrawl.dev/v2/search");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({
      Authorization: "Bearer fc-test-key",
      "Content-Type": "application/json",
    });
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.query).toBe("test query");
    expect(body.limit).toBe(3);
  });

  it("uses default limit of 5", async () => {
    const mockFetch = installMockFetch({ success: true, data: [] });
    const tool = createFirecrawlSearchTool(configWithApiKey("fc-test-key"));
    await tool?.execute?.("call-1", { query: "test" });

    const body = JSON.parse(
      (mockFetch.mock.calls[0] as [string, RequestInit])[1].body as string,
    ) as Record<string, unknown>;
    expect(body.limit).toBe(5);
  });

  it("clamps limit to 20", async () => {
    const mockFetch = installMockFetch({ success: true, data: [] });
    const tool = createFirecrawlSearchTool(configWithApiKey("fc-test-key"));
    await tool?.execute?.("call-1", { query: "test", limit: 50 });

    const body = JSON.parse(
      (mockFetch.mock.calls[0] as [string, RequestInit])[1].body as string,
    ) as Record<string, unknown>;
    expect(body.limit).toBe(20);
  });

  it("wraps result descriptions but keeps URLs raw", async () => {
    installMockFetch({
      success: true,
      data: [
        {
          title: "Test Title",
          url: "https://example.com/page",
          description: "Test description",
        },
      ],
    });
    const tool = createFirecrawlSearchTool(configWithApiKey("fc-test-key"));
    const result = await tool?.execute?.("call-1", { query: "test" });
    const details = result?.details as {
      results?: Array<{ title?: string; url?: string; description?: string }>;
      externalContent?: { untrusted?: boolean; wrapped?: boolean };
    };

    // URL should be raw for tool chaining
    expect(details.results?.[0]?.url).toBe("https://example.com/page");
    // Title and description should be wrapped
    expect(details.results?.[0]?.title).toMatch(
      /<<<EXTERNAL_UNTRUSTED_CONTENT id="[a-f0-9]{16}">>>/,
    );
    expect(details.results?.[0]?.description).toMatch(
      /<<<EXTERNAL_UNTRUSTED_CONTENT id="[a-f0-9]{16}">>>/,
    );
    expect(details.externalContent).toMatchObject({
      untrusted: true,
      wrapped: true,
    });
  });

  it("throws on API error", async () => {
    const mockFetch = vi.fn(() =>
      Promise.resolve({
        ok: false,
        status: 401,
        statusText: "Unauthorized",
        json: () => Promise.resolve({ success: false, error: "Invalid API key" }),
      } as Response),
    );
    global.fetch = withFetchPreconnect(mockFetch);

    const tool = createFirecrawlSearchTool(configWithApiKey("fc-bad-key"));
    await expect(tool?.execute?.("call-1", { query: "test" })).rejects.toThrow(
      /Firecrawl search failed \(401\)/,
    );
  });
});

describe("firecrawl_scrape tool", () => {
  const priorFetch = global.fetch;

  afterEach(() => {
    vi.unstubAllEnvs();
    global.fetch = priorFetch;
  });

  it("returns null when no Firecrawl API key is present", () => {
    vi.stubEnv("FIRECRAWL_API_KEY", "");
    const tool = createFirecrawlScrapeTool({ config: {} });
    expect(tool).toBeNull();
  });

  it("returns a tool when config API key is present", () => {
    const tool = createFirecrawlScrapeTool(configWithApiKey("fc-test-key"));
    expect(tool).not.toBeNull();
    expect(tool?.name).toBe("firecrawl_scrape");
  });

  it("calls fetchFirecrawlContent via the Firecrawl scrape API", async () => {
    const mockFetch = installMockFetch({
      success: true,
      data: {
        markdown: "# Hello World\n\nSome content here.",
        metadata: {
          title: "Hello World",
          sourceURL: "https://example.com/hello",
          statusCode: 200,
        },
      },
    });

    const tool = createFirecrawlScrapeTool(configWithApiKey("fc-test-key"));
    const result = await tool?.execute?.("call-1", { url: "https://example.com/hello" });

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/v2/scrape");
    expect(init.headers).toMatchObject({
      Authorization: "Bearer fc-test-key",
    });

    const details = result?.details as {
      url?: string;
      title?: string;
      text?: string;
      truncated?: boolean;
      externalContent?: { untrusted?: boolean; wrapped?: boolean };
    };
    expect(details.url).toBe("https://example.com/hello");
    expect(details.text).toContain("Hello World");
    expect(details.text).toMatch(/<<<EXTERNAL_UNTRUSTED_CONTENT id="[a-f0-9]{16}">>>/);
    expect(details.truncated).toBe(false);
    expect(details.externalContent).toMatchObject({
      untrusted: true,
      wrapped: true,
    });
  });

  it("truncates content when maxChars is specified", async () => {
    const longContent = "x".repeat(1000);
    installMockFetch({
      success: true,
      data: {
        markdown: longContent,
        metadata: { title: "Long", statusCode: 200 },
      },
    });

    const tool = createFirecrawlScrapeTool(configWithApiKey("fc-test-key"));
    const result = await tool?.execute?.("call-1", {
      url: "https://example.com",
      maxChars: 200,
    });

    const details = result?.details as { truncated?: boolean };
    expect(details.truncated).toBe(true);
  });
});
