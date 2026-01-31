import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as ssrf from "../../infra/net/ssrf.js";
import { createWebFetchTool } from "./web-tools.js";

type MockResponse = {
  ok: boolean;
  status: number;
  url?: string;
  headers?: { get: (key: string) => string | null };
  text?: () => Promise<string>;
  json?: () => Promise<unknown>;
};

function makeHeaders(map: Record<string, string>): { get: (key: string) => string | null } {
  return {
    get: (key) => map[key.toLowerCase()] ?? null,
  };
}

function htmlResponse(html: string, url = "https://example.com/"): MockResponse {
  return {
    ok: true,
    status: 200,
    url,
    headers: makeHeaders({ "content-type": "text/html; charset=utf-8" }),
    text: async () => html,
  };
}

function firecrawlResponse(markdown: string, url = "https://example.com/"): MockResponse {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      success: true,
      data: {
        markdown,
        metadata: { title: "Firecrawl Title", sourceURL: url, statusCode: 200 },
      },
    }),
  };
}

function firecrawlError(): MockResponse {
  return {
    ok: false,
    status: 403,
    json: async () => ({ success: false, error: "blocked" }),
  };
}

function errorHtmlResponse(
  html: string,
  status = 404,
  url = "https://example.com/",
  contentType: string | null = "text/html; charset=utf-8",
): MockResponse {
  return {
    ok: false,
    status,
    url,
    headers: contentType ? makeHeaders({ "content-type": contentType }) : makeHeaders({}),
    text: async () => html,
  };
}
function requestUrl(input: RequestInfo): string {
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

describe("web_fetch extraction fallbacks", () => {
  const priorFetch = global.fetch;

  beforeEach(() => {
    vi.spyOn(ssrf, "resolvePinnedHostname").mockImplementation(async (hostname) => {
      const normalized = hostname.trim().toLowerCase().replace(/\.$/, "");
      const addresses = ["93.184.216.34", "93.184.216.35"];
      return {
        hostname: normalized,
        addresses,
        lookup: ssrf.createPinnedLookup({ hostname: normalized, addresses }),
      };
    });
  });

  afterEach(() => {
    // @ts-expect-error restore
    global.fetch = priorFetch;
    vi.restoreAllMocks();
  });

  it("falls back to firecrawl when readability returns no content", async () => {
    const mockFetch = vi.fn((input: RequestInfo) => {
      const url = requestUrl(input);
      if (url.includes("api.firecrawl.dev")) {
        return Promise.resolve(firecrawlResponse("firecrawl content")) as Promise<Response>;
      }
      return Promise.resolve(
        htmlResponse("<!doctype html><html><head></head><body></body></html>", url),
      ) as Promise<Response>;
    });
    // @ts-expect-error mock fetch
    global.fetch = mockFetch;

    const tool = createWebFetchTool({
      config: {
        tools: {
          web: {
            fetch: {
              cacheTtlMinutes: 0,
              firecrawl: { apiKey: "firecrawl-test" },
            },
          },
        },
      },
      sandboxed: false,
    });

    const result = await tool?.execute?.("call", { url: "https://example.com/empty" });
    const details = result?.details as { extractor?: string; text?: string };
    expect(details.extractor).toBe("firecrawl");
    expect(details.text).toContain("firecrawl content");
  });

  it("returns error result when readability is disabled and firecrawl is unavailable", async () => {
    const mockFetch = vi.fn((input: RequestInfo) =>
      Promise.resolve(htmlResponse("<html><body>hi</body></html>", requestUrl(input))),
    );
    // @ts-expect-error mock fetch
    global.fetch = mockFetch;

    const tool = createWebFetchTool({
      config: {
        tools: {
          web: {
            fetch: { readability: false, cacheTtlMinutes: 0, firecrawl: { enabled: false } },
          },
        },
      },
      sandboxed: false,
    });

    const result = await tool?.execute?.("call", {
      url: "https://example.com/readability-off",
    });
    const details = result?.details as { status?: string; error?: string };
    expect(details.status).toBe("error");
    expect(details.error).toContain("Readability disabled");
  });

  it("returns error result when readability is empty and firecrawl fails", async () => {
    const mockFetch = vi.fn((input: RequestInfo) => {
      const url = requestUrl(input);
      if (url.includes("api.firecrawl.dev")) {
        return Promise.resolve(firecrawlError()) as Promise<Response>;
      }
      return Promise.resolve(
        htmlResponse("<!doctype html><html><head></head><body></body></html>", url),
      ) as Promise<Response>;
    });
    // @ts-expect-error mock fetch
    global.fetch = mockFetch;

    const tool = createWebFetchTool({
      config: {
        tools: {
          web: {
            fetch: { cacheTtlMinutes: 0, firecrawl: { apiKey: "firecrawl-test" } },
          },
        },
      },
      sandboxed: false,
    });

    const result = await tool?.execute?.("call", {
      url: "https://example.com/readability-empty",
    });
    const details = result?.details as { status?: string; error?: string };
    expect(details.status).toBe("error");
    expect(details.error).toContain("Readability and Firecrawl returned no content");
  });

  it("uses firecrawl when direct fetch fails", async () => {
    const mockFetch = vi.fn((input: RequestInfo) => {
      const url = requestUrl(input);
      if (url.includes("api.firecrawl.dev")) {
        return Promise.resolve(firecrawlResponse("firecrawl fallback", url)) as Promise<Response>;
      }
      return Promise.resolve({
        ok: false,
        status: 403,
        headers: makeHeaders({ "content-type": "text/html" }),
        text: async () => "blocked",
      } as Response);
    });
    // @ts-expect-error mock fetch
    global.fetch = mockFetch;

    const tool = createWebFetchTool({
      config: {
        tools: {
          web: {
            fetch: { cacheTtlMinutes: 0, firecrawl: { apiKey: "firecrawl-test" } },
          },
        },
      },
      sandboxed: false,
    });

    const result = await tool?.execute?.("call", { url: "https://example.com/blocked" });
    const details = result?.details as { extractor?: string; text?: string };
    expect(details.extractor).toBe("firecrawl");
    expect(details.text).toContain("firecrawl fallback");
  });
  it("strips and truncates HTML from error responses", async () => {
    const long = "x".repeat(12_000);
    const html =
      "<!doctype html><html><head><title>Not Found</title></head><body><h1>Not Found</h1><p>" +
      long +
      "</p></body></html>";
    const mockFetch = vi.fn((input: RequestInfo) =>
      Promise.resolve(errorHtmlResponse(html, 404, requestUrl(input), "Text/HTML; charset=utf-8")),
    );
    // @ts-expect-error mock fetch
    global.fetch = mockFetch;

    const tool = createWebFetchTool({
      config: {
        tools: {
          web: {
            fetch: { cacheTtlMinutes: 0, firecrawl: { enabled: false } },
          },
        },
      },
      sandboxed: false,
    });

    const result = await tool?.execute?.("call", { url: "https://example.com/missing" });
    const details = result?.details as { status?: string; error?: string };
    expect(details.status).toBe("error");
    expect(details.error).toContain("Web fetch failed");
    expect(details.error).toContain("404");
    expect(details.error).toContain("Not Found");
    expect(details.error).not.toContain("<html");
    expect(details.error!.length).toBeLessThan(5_000);
  });

  it("strips HTML errors when content-type is missing", async () => {
    const html =
      "<!DOCTYPE HTML><html><head><title>Oops</title></head><body><h1>Oops</h1></body></html>";
    const mockFetch = vi.fn((input: RequestInfo) =>
      Promise.resolve(errorHtmlResponse(html, 500, requestUrl(input), null)),
    );
    // @ts-expect-error mock fetch
    global.fetch = mockFetch;

    const tool = createWebFetchTool({
      config: {
        tools: {
          web: {
            fetch: { cacheTtlMinutes: 0, firecrawl: { enabled: false } },
          },
        },
      },
      sandboxed: false,
    });

    const result = await tool?.execute?.("call", { url: "https://example.com/oops" });
    const details = result?.details as { status?: string; error?: string };
    expect(details.status).toBe("error");
    expect(details.error).toMatch(/Web fetch failed.*500.*Oops/);
  });

  it("returns error result for network-level TypeError instead of crashing", async () => {
    const mockFetch = vi.fn(() => Promise.reject(new TypeError("fetch failed")));
    // @ts-expect-error mock fetch
    global.fetch = mockFetch;

    const tool = createWebFetchTool({
      config: {
        tools: {
          web: {
            fetch: { cacheTtlMinutes: 0, firecrawl: { enabled: false } },
          },
        },
      },
      sandboxed: false,
    });

    const result = await tool?.execute?.("call", { url: "https://unreachable.example.com/" });
    const details = result?.details as { status?: string; error?: string; url?: string };
    expect(details.status).toBe("error");
    expect(details.error).toContain("fetch failed");
    expect(details.url).toBe("https://unreachable.example.com/");
  });
});
