import { describe, expect, it } from "vitest";
import { __testing as braveTesting } from "../../../extensions/brave/src/brave-web-search-provider.js";
import { __testing as moonshotTesting } from "../../../extensions/moonshot/src/kimi-web-search-provider.js";
import { __testing as perplexityTesting } from "../../../extensions/perplexity/web-search-provider.js";
import { __testing as xaiTesting } from "../../../extensions/xai/src/grok-web-search-provider.js";
import {
  buildUnsupportedSearchFilterResponse,
  mergeScopedSearchConfig,
} from "../../plugin-sdk/provider-web-search.js";
import { withEnv } from "../../test-utils/env.js";
const {
  inferPerplexityBaseUrlFromApiKey,
  resolvePerplexityBaseUrl,
  resolvePerplexityModel,
  resolvePerplexityTransport,
  isDirectPerplexityBaseUrl,
  resolvePerplexityRequestModel,
  resolvePerplexityApiKey,
  normalizeToIsoDate,
  isoToPerplexityDate,
} = perplexityTesting;
const {
  normalizeBraveLanguageParams,
  normalizeFreshness,
  resolveBraveMode,
  mapBraveLlmContextResults,
} = braveTesting;
const { resolveGrokApiKey, resolveGrokModel, resolveGrokInlineCitations, extractGrokContent } =
  xaiTesting;
const { resolveKimiApiKey, resolveKimiModel, resolveKimiBaseUrl, extractKimiCitations } =
  moonshotTesting;

const kimiApiKeyEnv = ["KIMI_API", "KEY"].join("_");
const openRouterApiKeyEnv = ["OPENROUTER_API", "KEY"].join("_");
const perplexityApiKeyEnv = ["PERPLEXITY_API", "KEY"].join("_");
const openRouterPerplexityApiKey = ["sk", "or", "v1", "test"].join("-");
const directPerplexityApiKey = ["pplx", "test"].join("-");
const enterprisePerplexityApiKey = ["enterprise", "perplexity", "test"].join("-");

describe("web_search perplexity compatibility routing", () => {
  it("detects API key prefixes", () => {
    expect(inferPerplexityBaseUrlFromApiKey("pplx-123")).toBe("direct");
    expect(inferPerplexityBaseUrlFromApiKey("sk-or-v1-123")).toBe("openrouter");
    expect(inferPerplexityBaseUrlFromApiKey("unknown-key")).toBeUndefined();
  });

  it("prefers explicit baseUrl over key-based defaults", () => {
    expect(resolvePerplexityBaseUrl({ baseUrl: "https://example.com" }, "config", "pplx-123")).toBe(
      "https://example.com",
    );
  });

  it("resolves OpenRouter env auth and transport", () => {
    withEnv(
      { [perplexityApiKeyEnv]: undefined, [openRouterApiKeyEnv]: openRouterPerplexityApiKey },
      () => {
        expect(resolvePerplexityApiKey(undefined)).toEqual({
          apiKey: openRouterPerplexityApiKey,
          source: "openrouter_env",
        });
        expect(resolvePerplexityTransport(undefined)).toMatchObject({
          baseUrl: "https://openrouter.ai/api/v1",
          model: "perplexity/sonar-pro",
          transport: "chat_completions",
        });
      },
    );
  });

  it("uses native Search API for direct Perplexity when no legacy overrides exist", () => {
    withEnv(
      { [perplexityApiKeyEnv]: directPerplexityApiKey, [openRouterApiKeyEnv]: undefined },
      () => {
        expect(resolvePerplexityTransport(undefined)).toMatchObject({
          baseUrl: "https://api.perplexity.ai",
          model: "perplexity/sonar-pro",
          transport: "search_api",
        });
      },
    );
  });

  it("switches direct Perplexity to chat completions when model override is configured", () => {
    expect(resolvePerplexityModel({ model: "perplexity/sonar-reasoning-pro" })).toBe(
      "perplexity/sonar-reasoning-pro",
    );
    expect(
      resolvePerplexityTransport({
        apiKey: directPerplexityApiKey,
        model: "perplexity/sonar-reasoning-pro",
      }),
    ).toMatchObject({
      baseUrl: "https://api.perplexity.ai",
      model: "perplexity/sonar-reasoning-pro",
      transport: "chat_completions",
    });
  });

  it("treats unrecognized configured keys as direct Perplexity by default", () => {
    expect(
      resolvePerplexityTransport({
        apiKey: enterprisePerplexityApiKey,
      }),
    ).toMatchObject({
      baseUrl: "https://api.perplexity.ai",
      transport: "search_api",
    });
  });

  it("normalizes direct Perplexity models for chat completions", () => {
    expect(isDirectPerplexityBaseUrl("https://api.perplexity.ai")).toBe(true);
    expect(isDirectPerplexityBaseUrl("https://openrouter.ai/api/v1")).toBe(false);
    expect(resolvePerplexityRequestModel("https://api.perplexity.ai", "perplexity/sonar-pro")).toBe(
      "sonar-pro",
    );
    expect(
      resolvePerplexityRequestModel("https://openrouter.ai/api/v1", "perplexity/sonar-pro"),
    ).toBe("perplexity/sonar-pro");
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

describe("web_search unsupported filter response", () => {
  it("returns undefined when no unsupported filter is set", () => {
    expect(buildUnsupportedSearchFilterResponse({ query: "openclaw" }, "gemini")).toBeUndefined();
  });

  it("maps non-date filters to provider-specific unsupported errors", () => {
    expect(buildUnsupportedSearchFilterResponse({ country: "us" }, "grok")).toEqual({
      error: "unsupported_country",
      message:
        "country filtering is not supported by the grok provider. Only Brave and Perplexity support country filtering.",
      docs: "https://docs.openclaw.ai/tools/web",
    });
  });

  it("collapses date filters to unsupported_date_filter", () => {
    expect(buildUnsupportedSearchFilterResponse({ date_before: "2026-03-19" }, "kimi")).toEqual({
      error: "unsupported_date_filter",
      message:
        "date_after/date_before filtering is not supported by the kimi provider. Only Brave and Perplexity support date filtering.",
      docs: "https://docs.openclaw.ai/tools/web",
    });
  });
});

describe("web_search scoped config merge", () => {
  it("returns the original config when no plugin config exists", () => {
    const searchConfig = { provider: "grok", grok: { model: "grok-4-1-fast" } };
    expect(mergeScopedSearchConfig(searchConfig, "grok", undefined)).toBe(searchConfig);
  });

  it("merges plugin config into the scoped provider object", () => {
    expect(
      mergeScopedSearchConfig({ provider: "grok", grok: { model: "old-model" } }, "grok", {
        model: "new-model",
        apiKey: "xai-test-key",
      }),
    ).toEqual({
      provider: "grok",
      grok: { model: "new-model", apiKey: "xai-test-key" },
    });
  });

  it("can mirror the plugin apiKey to the top level config", () => {
    expect(
      mergeScopedSearchConfig(
        { provider: "brave", brave: { count: 5 } },
        "brave",
        { apiKey: "brave-test-key" },
        { mirrorApiKeyToTopLevel: true },
      ),
    ).toEqual({
      provider: "brave",
      apiKey: "brave-test-key",
      brave: { count: 5, apiKey: "brave-test-key" },
    });
  });
});

describe("web_search kimi config resolution", () => {
  it("uses config apiKey when provided", () => {
    expect(resolveKimiApiKey({ apiKey: "kimi-test-key" })).toBe("kimi-test-key");
  });

  it("falls back to env apiKey", () => {
    withEnv({ [kimiApiKeyEnv]: "kimi-env-key" }, () => {
      expect(resolveKimiApiKey({})).toBe("kimi-env-key");
    });
  });

  it("uses config model when provided", () => {
    expect(resolveKimiModel({ model: "moonshot-v1-32k" })).toBe("moonshot-v1-32k");
  });

  it("falls back to default model", () => {
    expect(resolveKimiModel({})).toBe("moonshot-v1-128k");
  });

  it("uses config baseUrl when provided", () => {
    expect(resolveKimiBaseUrl({ baseUrl: "https://kimi.example/v1" })).toBe(
      "https://kimi.example/v1",
    );
  });

  it("falls back to default baseUrl", () => {
    expect(resolveKimiBaseUrl({})).toBe("https://api.moonshot.ai/v1");
  });

  it("extracts citations from search_results", () => {
    expect(
      extractKimiCitations({
        search_results: [{ url: "https://example.com/one" }, { url: "https://example.com/two" }],
      }),
    ).toEqual(["https://example.com/one", "https://example.com/two"]);
  });
});

describe("web_search brave mode resolution", () => {
  it("defaults to web mode", () => {
    expect(resolveBraveMode({})).toBe("web");
  });

  it("honors explicit llm-context mode", () => {
    expect(resolveBraveMode({ mode: "llm-context" })).toBe("llm-context");
  });

  it("maps llm context results", () => {
    expect(
      mapBraveLlmContextResults({
        grounding: {
          generic: [{ url: "https://example.com", title: "Example", snippets: ["A", "B"] }],
        },
        sources: [{ url: "https://example.com", hostname: "example.com", date: "2024-01-01" }],
      }),
    ).toEqual([
      {
        title: "Example",
        url: "https://example.com",
        description: "A B",
        age: "2024-01-01",
      },
    ]);
  });
});

describe("web_search grok config resolution", () => {
  it("uses config apiKey when provided", () => {
    expect(resolveGrokApiKey({ apiKey: "xai-test-key" })).toBe("xai-test-key");
  });

  it("falls back to env apiKey", () => {
    withEnv({ XAI_API_KEY: "xai-env-key" }, () => {
      expect(resolveGrokApiKey({})).toBe("xai-env-key");
    });
  });

  it("uses config model when provided", () => {
    expect(resolveGrokModel({ model: "grok-4-fast" })).toBe("grok-4-fast");
  });

  it("falls back to default model", () => {
    expect(resolveGrokModel({})).toBe("grok-4-1-fast");
  });

  it("resolves inline citations flag", () => {
    expect(resolveGrokInlineCitations({ inlineCitations: true })).toBe(true);
    expect(resolveGrokInlineCitations({ inlineCitations: false })).toBe(false);
    expect(resolveGrokInlineCitations({})).toBe(false);
  });

  it("extracts content and annotation citations", () => {
    expect(
      extractGrokContent({
        output: [
          {
            type: "message",
            content: [
              {
                type: "output_text",
                text: "Result",
                annotations: [{ type: "url_citation", url: "https://example.com" }],
              },
            ],
          },
        ],
      }),
    ).toEqual({
      text: "Result",
      annotationCitations: ["https://example.com"],
    });
  });
});
