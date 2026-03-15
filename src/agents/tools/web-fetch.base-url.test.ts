import { afterEach, describe, expect, it, vi } from "vitest";
import { withFetchPreconnect } from "../../test-utils/fetch-mock.js";
import { installWebFetchSsrfHarness } from "./web-fetch.test-harness.js";
import { createWebFetchTool } from "./web-tools.js";

vi.mock("./web-fetch-utils.js", async () => {
  const actual =
    await vi.importActual<typeof import("./web-fetch-utils.js")>("./web-fetch-utils.js");
  return {
    ...actual,
    extractReadableContent: vi.fn().mockResolvedValue({ text: "", title: undefined }),
  };
});

installWebFetchSsrfHarness();

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

function firecrawlResponse(markdown: string, url: string): Response {
  return new Response(
    JSON.stringify({
      success: true,
      data: {
        markdown,
        metadata: { title: "Firecrawl", sourceURL: url, statusCode: 200 },
      },
    }),
    {
      status: 200,
      headers: { "Content-Type": "application/json" },
    },
  );
}

function htmlResponse(): Response {
  return new Response("<!doctype html><html><head></head><body></body></html>", {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
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

describe("web_fetch firecrawl base URL fallback", () => {
  const priorFirecrawlBaseUrl = process.env.FIRECRAWL_BASE_URL;

  afterEach(() => {
    if (typeof priorFirecrawlBaseUrl === "string") {
      process.env.FIRECRAWL_BASE_URL = priorFirecrawlBaseUrl;
    } else {
      delete process.env.FIRECRAWL_BASE_URL;
    }
  });

  it("uses FIRECRAWL_BASE_URL env var when firecrawl.baseUrl is unset", async () => {
    process.env.FIRECRAWL_BASE_URL = "https://firecrawl-env.example";

    const fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
      const url = requestUrl(input);
      if (url.startsWith("https://firecrawl-env.example/v2/scrape")) {
        return firecrawlResponse("from env", url);
      }
      return htmlResponse();
    });
    global.fetch = withFetchPreconnect(fetchSpy);

    const tool = createFetchTool({
      firecrawl: { apiKey: "firecrawl-test" },
    });

    const result = await tool?.execute?.("call", { url: "https://example.com/from-env" });
    const details = result?.details as { extractor?: string; text?: string };

    expect(details.extractor).toBe("firecrawl");
    expect(details.text).toContain("from env");
    expect(
      fetchSpy.mock.calls.some(([input]) =>
        requestUrl(input).startsWith("https://firecrawl-env.example/v2/scrape"),
      ),
    ).toBe(true);
  });

  it("falls back to DEFAULT_FIRECRAWL_BASE_URL when config and env are unset", async () => {
    delete process.env.FIRECRAWL_BASE_URL;

    const fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
      const url = requestUrl(input);
      if (url.startsWith("https://api.firecrawl.dev/v2/scrape")) {
        return firecrawlResponse("from default", url);
      }
      return htmlResponse();
    });
    global.fetch = withFetchPreconnect(fetchSpy);

    const tool = createFetchTool({
      firecrawl: { apiKey: "firecrawl-test" },
    });

    const result = await tool?.execute?.("call", { url: "https://example.com/from-default" });
    const details = result?.details as { extractor?: string; text?: string };

    expect(details.extractor).toBe("firecrawl");
    expect(details.text).toContain("from default");
    expect(
      fetchSpy.mock.calls.some(([input]) =>
        requestUrl(input).startsWith("https://api.firecrawl.dev/v2/scrape"),
      ),
    ).toBe(true);
  });
});
