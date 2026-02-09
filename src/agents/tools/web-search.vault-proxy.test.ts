import { afterEach, describe, expect, it, vi } from "vitest";
import { withEnv } from "../../test-utils/env.js";
import { createWebSearchTool, __testing } from "./web-search.js";

const {
  inferPerplexityBaseUrlFromApiKey,
  resolvePerplexityBaseUrl,
  isDirectPerplexityBaseUrl,
  resolvePerplexityRequestModel,
  normalizeFreshness,
  freshnessToPerplexityRecency,
  resolveGrokApiKey,
  resolveGrokModel,
  resolveGrokInlineCitations,
  extractGrokContent,
} = __testing;

describe("web_search perplexity baseUrl defaults", () => {
  it("detects a Perplexity key prefix", () => {
    expect(inferPerplexityBaseUrlFromApiKey("pplx-123")).toBe("direct");
  });

  it("detects an OpenRouter key prefix", () => {
    expect(inferPerplexityBaseUrlFromApiKey("sk-or-v1-123")).toBe("openrouter");
  });

  it("returns undefined for unknown key formats", () => {
    expect(inferPerplexityBaseUrlFromApiKey("unknown-key")).toBeUndefined();
  });

  it("prefers explicit baseUrl over key-based defaults", () => {
    expect(resolvePerplexityBaseUrl({ baseUrl: "https://example.com" }, "config", "pplx-123")).toBe(
      "https://example.com",
    );
  });

  it("defaults to direct when using PERPLEXITY_API_KEY", () => {
    expect(resolvePerplexityBaseUrl(undefined, "perplexity_env")).toBe("https://api.perplexity.ai");
  });

  it("defaults to OpenRouter when using OPENROUTER_API_KEY", () => {
    expect(resolvePerplexityBaseUrl(undefined, "openrouter_env")).toBe(
      "https://openrouter.ai/api/v1",
    );
  });

  it("defaults to direct when config key looks like Perplexity", () => {
    expect(resolvePerplexityBaseUrl(undefined, "config", "pplx-123")).toBe(
      "https://api.perplexity.ai",
    );
  });

  it("defaults to OpenRouter when config key looks like OpenRouter", () => {
    expect(resolvePerplexityBaseUrl(undefined, "config", "sk-or-v1-123")).toBe(
      "https://openrouter.ai/api/v1",
    );
  });

  it("defaults to OpenRouter for unknown config key formats", () => {
    expect(resolvePerplexityBaseUrl(undefined, "config", "weird-key")).toBe(
      "https://openrouter.ai/api/v1",
    );
  });
});

describe("web_search perplexity model normalization", () => {
  it("detects direct Perplexity host", () => {
    expect(isDirectPerplexityBaseUrl("https://api.perplexity.ai")).toBe(true);
    expect(isDirectPerplexityBaseUrl("https://api.perplexity.ai/")).toBe(true);
    expect(isDirectPerplexityBaseUrl("https://openrouter.ai/api/v1")).toBe(false);
  });

  it("strips provider prefix for direct Perplexity", () => {
    expect(resolvePerplexityRequestModel("https://api.perplexity.ai", "perplexity/sonar-pro")).toBe(
      "sonar-pro",
    );
  });

  it("keeps prefixed model for OpenRouter", () => {
    expect(
      resolvePerplexityRequestModel("https://openrouter.ai/api/v1", "perplexity/sonar-pro"),
    ).toBe("perplexity/sonar-pro");
  });

  it("keeps model unchanged when URL is invalid", () => {
    expect(resolvePerplexityRequestModel("not-a-url", "perplexity/sonar-pro")).toBe(
      "perplexity/sonar-pro",
    );
  });
});

describe("web_search freshness normalization", () => {
  it("accepts Brave shortcut values", () => {
    expect(normalizeFreshness("pd")).toBe("pd");
    expect(normalizeFreshness("PW")).toBe("pw");
  });

  it("accepts valid date ranges", () => {
    expect(normalizeFreshness("2024-01-01to2024-01-31")).toBe("2024-01-01to2024-01-31");
  });

  it("rejects invalid date ranges", () => {
    expect(normalizeFreshness("2024-13-01to2024-01-31")).toBeUndefined();
    expect(normalizeFreshness("2024-02-30to2024-03-01")).toBeUndefined();
    expect(normalizeFreshness("2024-03-10to2024-03-01")).toBeUndefined();
  });
});

describe("freshnessToPerplexityRecency", () => {
  it("maps Brave shortcuts to Perplexity recency values", () => {
    expect(freshnessToPerplexityRecency("pd")).toBe("day");
    expect(freshnessToPerplexityRecency("pw")).toBe("week");
    expect(freshnessToPerplexityRecency("pm")).toBe("month");
    expect(freshnessToPerplexityRecency("py")).toBe("year");
  });

  it("returns undefined for date ranges (not supported by Perplexity)", () => {
    expect(freshnessToPerplexityRecency("2024-01-01to2024-01-31")).toBeUndefined();
  });

  it("returns undefined for undefined/empty input", () => {
    expect(freshnessToPerplexityRecency(undefined)).toBeUndefined();
    expect(freshnessToPerplexityRecency("")).toBeUndefined();
  });
});

describe("web_search grok config resolution", () => {
  it("uses config apiKey when provided", () => {
    expect(resolveGrokApiKey({ apiKey: "xai-test-key" })).toBe("xai-test-key");
  });

  it("returns undefined when no apiKey is available", () => {
    withEnv({ XAI_API_KEY: undefined }, () => {
      expect(resolveGrokApiKey({})).toBeUndefined();
      expect(resolveGrokApiKey(undefined)).toBeUndefined();
    });
  });

  it("uses default model when not specified", () => {
    expect(resolveGrokModel({})).toBe("grok-4-1-fast");
    expect(resolveGrokModel(undefined)).toBe("grok-4-1-fast");
  });

  it("uses config model when provided", () => {
    expect(resolveGrokModel({ model: "grok-3" })).toBe("grok-3");
  });

  it("defaults inlineCitations to false", () => {
    expect(resolveGrokInlineCitations({})).toBe(false);
    expect(resolveGrokInlineCitations(undefined)).toBe(false);
  });

  it("respects inlineCitations config", () => {
    expect(resolveGrokInlineCitations({ inlineCitations: true })).toBe(true);
    expect(resolveGrokInlineCitations({ inlineCitations: false })).toBe(false);
  });
});

describe("web_search grok response parsing", () => {
  it("extracts content from Responses API message blocks", () => {
    const result = extractGrokContent({
      output: [
        {
          type: "message",
          content: [{ type: "output_text", text: "hello from output" }],
        },
      ],
    });
    expect(result.text).toBe("hello from output");
    expect(result.annotationCitations).toEqual([]);
  });

  it("extracts url_citation annotations from content blocks", () => {
    const result = extractGrokContent({
      output: [
        {
          type: "message",
          content: [
            {
              type: "output_text",
              text: "hello with citations",
              annotations: [
                {
                  type: "url_citation",
                  url: "https://example.com/a",
                  start_index: 0,
                  end_index: 5,
                },
                {
                  type: "url_citation",
                  url: "https://example.com/b",
                  start_index: 6,
                  end_index: 10,
                },
                {
                  type: "url_citation",
                  url: "https://example.com/a",
                  start_index: 11,
                  end_index: 15,
                }, // duplicate
              ],
            },
          ],
        },
      ],
    });
    expect(result.text).toBe("hello with citations");
    expect(result.annotationCitations).toEqual(["https://example.com/a", "https://example.com/b"]);
  });

  it("falls back to deprecated output_text", () => {
    const result = extractGrokContent({ output_text: "hello from output_text" });
    expect(result.text).toBe("hello from output_text");
    expect(result.annotationCitations).toEqual([]);
  });

  it("returns undefined text when no content found", () => {
    const result = extractGrokContent({});
    expect(result.text).toBeUndefined();
    expect(result.annotationCitations).toEqual([]);
  });

  it("extracts output_text blocks directly in output array (no message wrapper)", () => {
    const result = extractGrokContent({
      output: [
        { type: "web_search_call" },
        {
          type: "output_text",
          text: "direct output text",
          annotations: [
            {
              type: "url_citation",
              url: "https://example.com/direct",
              start_index: 0,
              end_index: 5,
            },
          ],
        },
      ],
    } as Parameters<typeof extractGrokContent>[0]);
    expect(result.text).toBe("direct output text");
    expect(result.annotationCitations).toEqual(["https://example.com/direct"]);
  });
});

describe("web_search vault proxy integration", () => {
  it("creates tool when vault is disabled (unchanged behavior)", () => {
    const tool = createWebSearchTool({
      config: {
        vault: { enabled: false },
        tools: { web: { search: { enabled: true, provider: "brave" } } },
      },
    });
    expect(tool).not.toBeNull();
    expect(tool?.name).toBe("web_search");
  });

  it("creates tool when vault is enabled with brave proxy", () => {
    const tool = createWebSearchTool({
      config: {
        vault: {
          enabled: true,
          proxies: { brave: "http://vault:8089" },
        },
        tools: { web: { search: { enabled: true, provider: "brave" } } },
      },
    });
    expect(tool).not.toBeNull();
    expect(tool?.name).toBe("web_search");
  });

  it("creates tool when vault is enabled with xai proxy (grok provider)", () => {
    const tool = createWebSearchTool({
      config: {
        vault: {
          enabled: true,
          proxies: { xai: "http://vault:8087" },
        },
        tools: { web: { search: { enabled: true, provider: "grok" } } },
      },
    });
    expect(tool).not.toBeNull();
  });

  it("creates tool when vault is enabled with perplexity proxy", () => {
    const tool = createWebSearchTool({
      config: {
        vault: {
          enabled: true,
          proxies: { perplexity: "http://vault:8090" },
        },
        tools: { web: { search: { enabled: true, provider: "perplexity" } } },
      },
    });
    expect(tool).not.toBeNull();
  });

  it("creates tool without vault config (no vault section)", () => {
    const tool = createWebSearchTool({
      config: {
        tools: { web: { search: { enabled: true, provider: "brave" } } },
      },
    });
    expect(tool).not.toBeNull();
  });
});

describe("web_search vault proxy execute path", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("brave: routes through vault proxy URL, omits X-Subscription-Token", async () => {
    let capturedUrl = "";
    let capturedHeaders: Record<string, string> = {};
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      capturedUrl = url;
      capturedHeaders = Object.fromEntries(
        Object.entries(init?.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
      );
      return new Response(
        JSON.stringify({
          web: { results: [{ title: "test", url: "https://example.com", description: "desc" }] },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;
    vi.stubGlobal("fetch", fetchMock);

    const tool = createWebSearchTool({
      config: {
        vault: { enabled: true, proxies: { brave: "http://vault:8089" } },
        tools: { web: { search: { enabled: true, provider: "brave" } } },
      },
    })!;

    await tool.execute("t1", { query: "test query" });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(capturedUrl).toContain("http://vault:8089/res/v1/web/search");
    expect(capturedHeaders).not.toHaveProperty("x-subscription-token");
  });

  it("perplexity: routes through vault proxy URL, omits Authorization header", async () => {
    let capturedUrl = "";
    let capturedHeaders: Record<string, string> = {};
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      capturedUrl = url;
      capturedHeaders = Object.fromEntries(
        Object.entries(init?.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
      );
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: "answer" } }],
          citations: ["https://example.com"],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;
    vi.stubGlobal("fetch", fetchMock);

    const tool = createWebSearchTool({
      config: {
        vault: { enabled: true, proxies: { perplexity: "http://vault:8090" } },
        tools: { web: { search: { enabled: true, provider: "perplexity" } } },
      },
    })!;

    await tool.execute("t2", { query: "test query" });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(capturedUrl).toBe("http://vault:8090/chat/completions");
    expect(capturedHeaders).not.toHaveProperty("authorization");
  });

  it("grok: routes through vault proxy URL, omits Authorization header", async () => {
    let capturedUrl = "";
    let capturedHeaders: Record<string, string> = {};
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      capturedUrl = url;
      capturedHeaders = Object.fromEntries(
        Object.entries(init?.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
      );
      return new Response(
        JSON.stringify({ output_text: "answer", citations: ["https://example.com"] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;
    vi.stubGlobal("fetch", fetchMock);

    const tool = createWebSearchTool({
      config: {
        vault: { enabled: true, proxies: { xai: "http://vault:8087" } },
        tools: { web: { search: { enabled: true, provider: "grok" } } },
      },
    })!;

    await tool.execute("t3", { query: "test query" });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(capturedUrl).toBe("http://vault:8087/v1/responses");
    expect(capturedHeaders).not.toHaveProperty("authorization");
  });
});
