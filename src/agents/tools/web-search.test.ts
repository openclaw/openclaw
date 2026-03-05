import { describe, expect, it } from "vitest";
import { withEnv } from "../../test-utils/env.js";
import { __testing } from "./web-search.js";

const {
  normalizeBraveLanguageParams,
  normalizeFreshness,
  normalizeToIsoDate,
  isoToPerplexityDate,
  resolveGrokApiKey,
  resolveGrokModel,
  resolveGrokInlineCitations,
  extractGrokContent,
  resolveKimiApiKey,
  resolveKimiModel,
  resolveKimiBaseUrl,
  extractKimiCitations,
  resolveArkApiKey,
  resolveArkModel,
  resolveArkBaseUrl,
  extractArkContent,
  resolveSearchProvider,
} = __testing;

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
  it("accepts Brave shortcut values and maps for Perplexity", () => {
    expect(normalizeFreshness("pd", "brave")).toBe("pd");
    expect(normalizeFreshness("PW", "brave")).toBe("pw");
    expect(normalizeFreshness("pd", "perplexity")).toBe("day");
    expect(normalizeFreshness("pw", "perplexity")).toBe("week");
  });

  it("accepts Perplexity values and maps for Brave", () => {
    expect(normalizeFreshness("day", "perplexity")).toBe("day");
    expect(normalizeFreshness("week", "perplexity")).toBe("week");
    expect(normalizeFreshness("day", "brave")).toBe("pd");
    expect(normalizeFreshness("week", "brave")).toBe("pw");
  });

  it("accepts valid date ranges for Brave", () => {
    expect(normalizeFreshness("2024-01-01to2024-01-31", "brave")).toBe("2024-01-01to2024-01-31");
  });

  it("rejects invalid values", () => {
    expect(normalizeFreshness("yesterday", "brave")).toBeUndefined();
    expect(normalizeFreshness("yesterday", "perplexity")).toBeUndefined();
    expect(normalizeFreshness("2024-01-01to2024-01-31", "perplexity")).toBeUndefined();
  });

  it("rejects invalid date ranges for Brave", () => {
    expect(normalizeFreshness("2024-13-01to2024-01-31", "brave")).toBeUndefined();
    expect(normalizeFreshness("2024-02-30to2024-03-01", "brave")).toBeUndefined();
    expect(normalizeFreshness("2024-03-10to2024-03-01", "brave")).toBeUndefined();
  });
});

describe("web_search date normalization", () => {
  it("accepts ISO format", () => {
    expect(normalizeToIsoDate("2024-01-15")).toBe("2024-01-15");
    expect(normalizeToIsoDate("2025-12-31")).toBe("2025-12-31");
  });

  it("accepts Perplexity format and converts to ISO", () => {
    expect(normalizeToIsoDate("1/15/2024")).toBe("2024-01-15");
    expect(normalizeToIsoDate("12/31/2025")).toBe("2025-12-31");
  });

  it("rejects invalid formats", () => {
    expect(normalizeToIsoDate("01-15-2024")).toBeUndefined();
    expect(normalizeToIsoDate("2024/01/15")).toBeUndefined();
    expect(normalizeToIsoDate("invalid")).toBeUndefined();
  });

  it("converts ISO to Perplexity format", () => {
    expect(isoToPerplexityDate("2024-01-15")).toBe("1/15/2024");
    expect(isoToPerplexityDate("2025-12-31")).toBe("12/31/2025");
    expect(isoToPerplexityDate("2024-03-05")).toBe("3/5/2024");
  });

  it("rejects invalid ISO dates", () => {
    expect(isoToPerplexityDate("1/15/2024")).toBeUndefined();
    expect(isoToPerplexityDate("invalid")).toBeUndefined();
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

describe("web_search ark config resolution", () => {
  it("uses config apiKey when provided", () => {
    expect(resolveArkApiKey({ apiKey: "ark-test-key" })).toBe("ark-test-key");
  });

  it("falls back to ARK_API_KEY, then VOLCENGINE_API_KEY, then VOLCANO_ENGINE_API_KEY", () => {
    withEnv(
      {
        ARK_API_KEY: "ark-env",
        VOLCENGINE_API_KEY: "volc-env",
        VOLCANO_ENGINE_API_KEY: "volcano-env",
      },
      () => {
        expect(resolveArkApiKey({})).toBe("ark-env");
      },
    );
    withEnv({ ARK_API_KEY: undefined, VOLCENGINE_API_KEY: "volc-env" }, () => {
      expect(resolveArkApiKey({})).toBe("volc-env");
    });
    withEnv(
      {
        ARK_API_KEY: undefined,
        VOLCENGINE_API_KEY: undefined,
        VOLCANO_ENGINE_API_KEY: "volcano-env",
      },
      () => {
        expect(resolveArkApiKey({})).toBe("volcano-env");
      },
    );
  });

  it("falls back to models.providers.volcengine.apiKey in full config", () => {
    const fullConfig = {
      models: {
        providers: {
          volcengine: {
            apiKey: "from-volcengine-provider",
          },
        },
      },
    };
    expect(resolveArkApiKey({}, fullConfig)).toBe("from-volcengine-provider");
  });

  it("returns undefined when no Ark key is configured", () => {
    withEnv(
      { ARK_API_KEY: undefined, VOLCENGINE_API_KEY: undefined, VOLCANO_ENGINE_API_KEY: undefined },
      () => {
        expect(resolveArkApiKey({})).toBeUndefined();
        expect(resolveArkApiKey(undefined)).toBeUndefined();
      },
    );
  });

  it("resolves default model and baseUrl", () => {
    expect(resolveArkModel({})).toBe("doubao-seed-1-6-250615");
    expect(resolveArkBaseUrl({})).toBe("https://ark.cn-beijing.volces.com/api/v3");
  });

  it("uses config model and baseUrl when provided", () => {
    expect(resolveArkModel({ model: "custom-model" })).toBe("custom-model");
    expect(resolveArkBaseUrl({ baseUrl: "https://custom.ark.com/api/v3" })).toBe(
      "https://custom.ark.com/api/v3",
    );
  });
});

describe("web_search ark response parsing", () => {
  it("extracts content from Responses API message blocks", () => {
    const result = extractArkContent({
      output: [
        {
          type: "message",
          content: [{ type: "output_text", text: "hello from ark output" }],
        },
      ],
    });
    expect(result.text).toBe("hello from ark output");
  });

  it("extracts output_text blocks directly in output array", () => {
    const result = extractArkContent({
      output: [
        { type: "web_search" },
        {
          type: "output_text",
          text: "direct output text from ark",
        },
      ],
    });
    expect(result.text).toBe("direct output text from ark");
  });

  it("falls back to output_text field", () => {
    const result = extractArkContent({ output_text: "hello from output_text field" });
    expect(result.text).toBe("hello from output_text field");
  });

  it("returns undefined text when no content found", () => {
    const result = extractArkContent({});
    expect(result.text).toBeUndefined();
  });
});

describe("web_search ark provider auto-detection", () => {
  it("auto-detects ark when only ARK_API_KEY is set", () => {
    withEnv(
      {
        ARK_API_KEY: "test-ark-key",
        BRAVE_API_KEY: undefined,
        GEMINI_API_KEY: undefined,
        KIMI_API_KEY: undefined,
      },
      () => {
        expect(resolveSearchProvider({})).toBe("ark");
      },
    );
  });

  it("auto-detects ark when only VOLCENGINE_API_KEY is set", () => {
    withEnv(
      {
        VOLCENGINE_API_KEY: "test-volc-key",
        BRAVE_API_KEY: undefined,
        GEMINI_API_KEY: undefined,
        KIMI_API_KEY: undefined,
      },
      () => {
        expect(resolveSearchProvider({})).toBe("ark");
      },
    );
  });

  it("auto-detects ark when only VOLCANO_ENGINE_API_KEY is set", () => {
    withEnv(
      {
        VOLCANO_ENGINE_API_KEY: "test-volcano-key",
        BRAVE_API_KEY: undefined,
        GEMINI_API_KEY: undefined,
        KIMI_API_KEY: undefined,
      },
      () => {
        expect(resolveSearchProvider({})).toBe("ark");
      },
    );
  });

  it("explicit ark provider always wins", () => {
    withEnv({ BRAVE_API_KEY: "test-brave-key" }, () => {
      expect(
        resolveSearchProvider({
          provider: "ark",
        } as unknown as Parameters<typeof resolveSearchProvider>[0]),
      ).toBe("ark");
    });
  });
});
