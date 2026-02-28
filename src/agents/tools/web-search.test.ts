import { describe, expect, it } from "vitest";
import { withEnv } from "../../test-utils/env.js";
import { __testing } from "./web-search.js";

const {
  inferPerplexityBaseUrlFromApiKey,
  resolvePerplexityBaseUrl,
  isDirectPerplexityBaseUrl,
  resolvePerplexityRequestModel,
  normalizeBraveLanguageParams,
  normalizeFreshness,
  freshnessToPerplexityRecency,
  resolveGrokApiKey,
  resolveGrokModel,
  resolveGrokInlineCitations,
  extractGrokContent,
  resolveKimiApiKey,
  resolveKimiModel,
  resolveKimiBaseUrl,
  extractKimiCitations,
  freshnessToExaStartDate,
  freshnessToExaDates,
  resolveExaApiKey,
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

describe("web_search brave language param normalization", () => {
  it("normalizes and auto-corrects swapped Brave language params", () => {
    expect(normalizeBraveLanguageParams({ search_lang: "tr-TR", ui_lang: "tr" })).toEqual({
      search_lang: "tr",
      ui_lang: "tr-TR",
    });
    expect(normalizeBraveLanguageParams({ search_lang: "EN", ui_lang: "en-us" })).toEqual({
      search_lang: "en",
      ui_lang: "en-US",
    });
  });

  it("flags invalid Brave language formats", () => {
    expect(normalizeBraveLanguageParams({ search_lang: "en-US" })).toEqual({
      invalidField: "search_lang",
    });
    expect(normalizeBraveLanguageParams({ ui_lang: "en" })).toEqual({
      invalidField: "ui_lang",
    });
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

describe("web_search kimi config resolution", () => {
  it("uses config apiKey when provided", () => {
    expect(resolveKimiApiKey({ apiKey: "kimi-test-key" })).toBe("kimi-test-key");
  });

  it("falls back to KIMI_API_KEY, then MOONSHOT_API_KEY", () => {
    withEnv({ KIMI_API_KEY: "kimi-env", MOONSHOT_API_KEY: "moonshot-env" }, () => {
      expect(resolveKimiApiKey({})).toBe("kimi-env");
    });
    withEnv({ KIMI_API_KEY: undefined, MOONSHOT_API_KEY: "moonshot-env" }, () => {
      expect(resolveKimiApiKey({})).toBe("moonshot-env");
    });
  });

  it("returns undefined when no Kimi key is configured", () => {
    withEnv({ KIMI_API_KEY: undefined, MOONSHOT_API_KEY: undefined }, () => {
      expect(resolveKimiApiKey({})).toBeUndefined();
      expect(resolveKimiApiKey(undefined)).toBeUndefined();
    });
  });

  it("resolves default model and baseUrl", () => {
    expect(resolveKimiModel({})).toBe("moonshot-v1-128k");
    expect(resolveKimiBaseUrl({})).toBe("https://api.moonshot.ai/v1");
  });
});

describe("extractKimiCitations", () => {
  it("collects unique URLs from search_results and tool arguments", () => {
    expect(
      extractKimiCitations({
        search_results: [{ url: "https://example.com/a" }, { url: "https://example.com/a" }],
        choices: [
          {
            message: {
              tool_calls: [
                {
                  function: {
                    arguments: JSON.stringify({
                      search_results: [{ url: "https://example.com/b" }],
                      url: "https://example.com/c",
                    }),
                  },
                },
              ],
            },
          },
        ],
      }).toSorted(),
    ).toEqual(["https://example.com/a", "https://example.com/b", "https://example.com/c"]);
  });
});

describe("exa freshnessToExaStartDate", () => {
  it("returns a date string for 'pd' (yesterday)", () => {
    const result = freshnessToExaStartDate("pd");
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const yesterday = new Date();
    yesterday.setUTCDate(yesterday.getUTCDate() - 1);
    expect(result).toBe(yesterday.toISOString().slice(0, 10));
  });

  it("returns a date string for 'pw' (7 days ago)", () => {
    const result = freshnessToExaStartDate("pw");
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const expected = new Date();
    expected.setUTCDate(expected.getUTCDate() - 7);
    expect(result).toBe(expected.toISOString().slice(0, 10));
  });

  it("returns a date string for 'pm' (30 days ago)", () => {
    const result = freshnessToExaStartDate("pm");
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const expected = new Date();
    expected.setUTCDate(expected.getUTCDate() - 30);
    expect(result).toBe(expected.toISOString().slice(0, 10));
  });

  it("returns a date string for 'py' (365 days ago)", () => {
    const result = freshnessToExaStartDate("py");
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const expected = new Date();
    expected.setUTCDate(expected.getUTCDate() - 365);
    expect(result).toBe(expected.toISOString().slice(0, 10));
  });

  it("extracts start date from a date range (deprecated compat)", () => {
    expect(freshnessToExaStartDate("2024-03-01to2024-03-31")).toBe("2024-03-01");
  });

  it("returns undefined for unknown freshness values", () => {
    expect(freshnessToExaStartDate("invalid")).toBeUndefined();
  });

  it("is case-insensitive for shortcuts", () => {
    const pd = freshnessToExaStartDate("PD");
    const pw = freshnessToExaStartDate("PW");
    expect(pd).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(pw).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("exa freshnessToExaDates", () => {
  it("returns only startPublishedDate for shortcut values", () => {
    const result = freshnessToExaDates("pd");
    expect(result.startPublishedDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(result.endPublishedDate).toBeUndefined();
  });

  it("returns both startPublishedDate and endPublishedDate for date ranges", () => {
    const result = freshnessToExaDates("2024-03-01to2024-03-31");
    expect(result.startPublishedDate).toBe("2024-03-01");
    expect(result.endPublishedDate).toBe("2024-03-31");
  });

  it("is case-insensitive for date range extraction", () => {
    const result = freshnessToExaDates("2024-03-01TO2024-03-31");
    expect(result.startPublishedDate).toBe("2024-03-01");
    expect(result.endPublishedDate).toBe("2024-03-31");
  });

  it("returns empty object for unknown values", () => {
    const result = freshnessToExaDates("invalid");
    expect(result.startPublishedDate).toBeUndefined();
    expect(result.endPublishedDate).toBeUndefined();
  });
});

describe("exa resolveExaApiKey", () => {
  it("returns undefined when no config or env key", () => {
    const original = process.env.EXA_API_KEY;
    delete process.env.EXA_API_KEY;
    expect(resolveExaApiKey({})).toBeUndefined();
    process.env.EXA_API_KEY = original;
  });

  it("prefers config apiKey over env var", () => {
    const original = process.env.EXA_API_KEY;
    process.env.EXA_API_KEY = "env-key";
    expect(resolveExaApiKey({ apiKey: "config-key" })).toBe("config-key");
    process.env.EXA_API_KEY = original;
  });

  it("falls back to EXA_API_KEY env var", () => {
    const original = process.env.EXA_API_KEY;
    process.env.EXA_API_KEY = "env-exa-key";
    expect(resolveExaApiKey({})).toBe("env-exa-key");
    process.env.EXA_API_KEY = original;
  });

  it("trims whitespace from config apiKey", () => {
    expect(resolveExaApiKey({ apiKey: "  trimmed-key  " })).toBe("trimmed-key");
  });
});
