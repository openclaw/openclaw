import { Type } from "@sinclair/typebox";
import type { OpenClawConfig } from "../../config/config.js";
import type { AnyAgentTool } from "./common.js";
import { formatCliCommand } from "../../cli/command-format.js";
import { wrapWebContent } from "../../security/external-content.js";
import { jsonResult, readNumberParam, readStringParam } from "./common.js";
import {
  createProvider,
  type WebSearchOptions,
  type WebSearchProvider,
  type SearchProviderType,
} from "./web-search-providers.js";
import {
  CacheEntry,
  DEFAULT_CACHE_TTL_MINUTES,
  DEFAULT_TIMEOUT_SECONDS,
  normalizeCacheKey,
  readCache,
  resolveCacheTtlMs,
  resolveTimeoutSeconds,
  writeCache,
} from "./web-shared.js";

const _SEARCH_PROVIDERS = ["brave", "perplexity", "serper"] as const;
const DEFAULT_SEARCH_COUNT = 5;
const MAX_SEARCH_COUNT = 10;

const SEARCH_CACHE = new Map<string, CacheEntry<Record<string, unknown>>>();
const BRAVE_FRESHNESS_SHORTCUTS = new Set(["pd", "pw", "pm", "py"]);
const BRAVE_FRESHNESS_RANGE = /^(\d{4}-\d{2}-\d{2})to(\d{4}-\d{2}-\d{2})$/;

const WebSearchSchema = Type.Object({
  query: Type.String({ description: "Search query string." }),
  count: Type.Optional(
    Type.Number({
      description: "Number of results to return (1-10).",
      minimum: 1,
      maximum: MAX_SEARCH_COUNT,
    }),
  ),
  country: Type.Optional(
    Type.String({
      description:
        "2-letter country code for region-specific results (e.g., 'DE', 'US', 'ALL'). Default: 'US'.",
    }),
  ),
  search_lang: Type.Optional(
    Type.String({
      description: "ISO language code for search results (e.g., 'de', 'en', 'fr').",
    }),
  ),
  ui_lang: Type.Optional(
    Type.String({
      description: "ISO language code for UI elements.",
    }),
  ),
  freshness: Type.Optional(
    Type.String({
      description:
        "Filter results by discovery time (Brave only). Values: 'pd' (past 24h), 'pw' (past week), 'pm' (past month), 'py' (past year), or date range 'YYYY-MM-DDtoYYYY-MM-DD'.",
    }),
  ),
});

type WebSearchConfig = NonNullable<OpenClawConfig["tools"]>["web"] extends infer Web
  ? Web extends { search?: infer Search }
    ? Search
    : undefined
  : undefined;

function resolveSearchConfig(cfg?: OpenClawConfig): WebSearchConfig {
  const search = cfg?.tools?.web?.search;
  if (!search || typeof search !== "object") {
    return undefined;
  }
  return search as WebSearchConfig;
}

function resolveSearchEnabled(params: { search?: WebSearchConfig; sandboxed?: boolean }): boolean {
  if (typeof params.search?.enabled === "boolean") {
    return params.search.enabled;
  }
  if (params.sandboxed) {
    return true;
  }
  return true;
}

function resolveSearchProvider(search?: WebSearchConfig): SearchProviderType {
  const raw =
    search && "provider" in search && typeof search.provider === "string"
      ? search.provider.trim().toLowerCase()
      : "";
  if (raw === "perplexity") {
    return "perplexity";
  }
  if (raw === "serper") {
    return "serper";
  }
  if (raw === "brave") {
    return "brave";
  }
  return "brave";
}

function resolveFallbackProvider(search?: WebSearchConfig): SearchProviderType | undefined {
  const raw =
    search && "fallback" in search && typeof search.fallback === "string"
      ? search.fallback.trim().toLowerCase()
      : "";
  if (!raw) {
    return undefined;
  }
  if (raw === "perplexity" || raw === "serper" || raw === "brave") {
    return raw as SearchProviderType;
  }
  return undefined;
}

function resolveSearchCount(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  const clamped = Math.max(1, Math.min(MAX_SEARCH_COUNT, Math.floor(parsed)));
  return clamped;
}

function normalizeFreshness(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  const lower = trimmed.toLowerCase();
  if (BRAVE_FRESHNESS_SHORTCUTS.has(lower)) {
    return lower;
  }

  const match = trimmed.match(BRAVE_FRESHNESS_RANGE);
  if (!match) {
    return undefined;
  }

  const [, start, end] = match;
  if (!isValidIsoDate(start) || !isValidIsoDate(end)) {
    return undefined;
  }
  if (start > end) {
    return undefined;
  }

  return `${start}to${end}`;
}

function isValidIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const [year, month, day] = value.split("-").map((part) => Number.parseInt(part, 10));
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
    return false;
  }

  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

function _missingSearchKeyPayload(provider: SearchProviderType): Record<string, unknown> {
  if (provider === "perplexity") {
    return {
      error: "missing_perplexity_api_key",
      message:
        "web_search (perplexity) needs an API key. Set PERPLEXITY_API_KEY or OPENROUTER_API_KEY in the Gateway environment, or configure tools.web.search.perplexity.apiKey.",
      docs: "https://docs.openclaw.ai/tools/web",
    };
  }
  if (provider === "serper") {
    return {
      error: "missing_serper_api_key",
      message:
        "web_search (serper) needs an API key. Set SERPER_API_KEY in the Gateway environment, or configure tools.web.search.serper.apiKey.",
      docs: "https://docs.openclaw.ai/tools/web",
    };
  }
  return {
    error: "missing_brave_api_key",
    message: `web_search needs a Brave Search API key. Run \`${formatCliCommand("openclaw configure --section web")}\` to store it, or set BRAVE_API_KEY in the Gateway environment.`,
    docs: "https://docs.openclaw.ai/tools/web",
  };
}

function extractProviderConfig(search: WebSearchConfig | undefined) {
  return {
    brave: search && "apiKey" in search ? { apiKey: search.apiKey } : undefined,
    perplexity: search && "perplexity" in search ? search.perplexity : undefined,
    serper: search && "serper" in search ? search.serper : undefined,
  };
}

/**
 * Wrap search result content with web content security wrapper.
 */
function wrapSearchResult(result: Record<string, unknown>): Record<string, unknown> {
  // Wrap Perplexity content
  if ("content" in result && typeof result.content === "string") {
    return { ...result, content: wrapWebContent(result.content) };
  }

  // Wrap structured results (Brave/Serper)
  if ("results" in result && Array.isArray(result.results)) {
    return {
      ...result,
      results: result.results.map((entry: unknown) => {
        if (typeof entry === "object" && entry !== null) {
          const wrapped: Record<string, unknown> = {};
          if ("title" in entry && typeof entry.title === "string") {
            wrapped.title = wrapWebContent(entry.title, "web_search");
          } else {
            wrapped.title = "";
          }
          if ("description" in entry && typeof entry.description === "string") {
            wrapped.description = wrapWebContent(entry.description, "web_search");
          } else {
            wrapped.description = "";
          }
          // Copy other fields
          if ("url" in entry) {
            wrapped.url = entry.url;
          }
          if ("published" in entry) {
            wrapped.published = entry.published;
          }
          if ("siteName" in entry) {
            wrapped.siteName = entry.siteName;
          }
          return wrapped;
        }
        return entry;
      }),
    };
  }

  return result;
}

async function runWebSearchWithFallback(
  provider: WebSearchProvider,
  fallbackProvider: WebSearchProvider | undefined,
  options: WebSearchOptions,
): Promise<Record<string, unknown>> {
  // Build cache key (fallback provider info will be added later if actually used)
  const baseCacheKey = `${provider.type}:${options.query}:${options.count}:${options.country || "default"}:${options.search_lang || "default"}:${options.ui_lang || "default"}:${options.freshness || "default"}`;
  const primaryCacheKey = normalizeCacheKey(baseCacheKey);

  const cached = readCache(SEARCH_CACHE, primaryCacheKey);
  if (cached) {
    return { ...cached.value, cached: true };
  }

  const start = Date.now();

  // Calculate timeouts: 70% for primary, 30% for fallback
  const primaryTimeoutSeconds = Math.max(1, Math.floor(options.timeoutSeconds * 0.7));
  const fallbackTimeoutSeconds = Math.max(1, Math.floor(options.timeoutSeconds * 0.3));

  // Try primary provider with reduced timeout
  try {
    const primaryOptions = { ...options, timeoutSeconds: primaryTimeoutSeconds };
    const result = await provider.search(primaryOptions);
    const payload = { ...result, tookMs: Date.now() - start };
    writeCache(SEARCH_CACHE, primaryCacheKey, payload, options.cacheTtlMs);
    return wrapSearchResult(payload);
  } catch (primaryError) {
    // If no fallback, re-throw
    if (!fallbackProvider) {
      throw primaryError;
    }

    // Build fallback cache key including fallback provider info
    const fallbackCacheKey = normalizeCacheKey(
      `${provider.type}:${fallbackProvider.type}:${baseCacheKey}`,
    );

    // Check cache again with fallback key
    const fallbackCached = readCache(SEARCH_CACHE, fallbackCacheKey);
    if (fallbackCached) {
      return { ...fallbackCached.value, cached: true };
    }

    // Try fallback provider with remaining timeout
    try {
      const fallbackOptions = { ...options, timeoutSeconds: fallbackTimeoutSeconds };
      const fallbackResult = await fallbackProvider.search(fallbackOptions);
      const payload = {
        ...fallbackResult,
        provider: fallbackProvider.type,
        fallbackFrom: provider.type,
        tookMs: Date.now() - start,
      };
      writeCache(SEARCH_CACHE, fallbackCacheKey, payload, options.cacheTtlMs);
      return wrapSearchResult(payload);
    } catch (fallbackError) {
      // Combine both errors, preserving the fallback error as the cause
      const errorMessage = `Primary provider (${provider.type}) failed: ${primaryError instanceof Error ? primaryError.message : String(primaryError)}; Fallback provider (${fallbackProvider.type}) also failed: ${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}`;
      const combinedError = new Error(errorMessage, { cause: fallbackError });
      throw combinedError;
    }
  }
}

export function createWebSearchTool(options?: {
  config?: OpenClawConfig;
  sandboxed?: boolean;
}): AnyAgentTool | null {
  const search = resolveSearchConfig(options?.config);
  if (!resolveSearchEnabled({ search, sandboxed: options?.sandboxed })) {
    return null;
  }

  const providerType = resolveSearchProvider(search);
  const fallbackType = resolveFallbackProvider(search);

  // Build provider config
  const providerConfig = extractProviderConfig(search);

  // Create providers
  let primaryProvider: WebSearchProvider | undefined;
  let fallbackProvider: WebSearchProvider | undefined;
  let fallbackInitError: Error | undefined;

  try {
    primaryProvider = createProvider(providerType, providerConfig);
  } catch (e) {
    // Provider creation failed (likely missing API key)
    // If there's a fallback, try it instead
    if (fallbackType) {
      try {
        primaryProvider = createProvider(fallbackType, providerConfig);
        // Swap: fallback becomes primary
        fallbackProvider = undefined;
      } catch (fallbackError) {
        // Both failed
        return {
          label: "Web Search",
          name: "web_search",
          description:
            "Search the web using configured provider with fallback support. (Currently misconfigured - see error)",
          parameters: WebSearchSchema,
          execute: async () => {
            return jsonResult({
              error: "provider_initialization_failed",
              message: `Failed to initialize primary provider (${providerType}): ${e instanceof Error ? e.message : String(e)}. Fallback provider (${fallbackType}) also failed: ${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}`,
            });
          },
        };
      }
    } else {
      return {
        label: "Web Search",
        name: "web_search",
        description: "Search the web. (Currently misconfigured - see error)",
        parameters: WebSearchSchema,
        execute: async () => {
          return jsonResult({
            error: "provider_initialization_failed",
            message: `Failed to initialize provider (${providerType}): ${e instanceof Error ? e.message : String(e)}`,
          });
        },
      };
    }
  }

  // Create fallback provider if configured
  if (fallbackType && primaryProvider) {
    try {
      fallbackProvider = createProvider(fallbackType, providerConfig);
    } catch (e) {
      // Fallback creation failed - record error for surfacing in tool description/payload
      fallbackInitError = e instanceof Error ? e : new Error(String(e));
      fallbackProvider = undefined;
    }
  }

  const description =
    providerType === "perplexity"
      ? "Search the web using Perplexity Sonar (direct or via OpenRouter). Returns AI-synthesized answers with citations from real-time web search."
      : providerType === "serper"
        ? "Search the web using Serper (Google Search API). Returns titles, URLs, and snippets for fast research."
        : fallbackProvider
          ? `Search the web using ${providerType} with ${fallbackType} fallback. Supports region-specific and localized search. Returns titles, URLs, and snippets for fast research.`
          : fallbackInitError
            ? `Search the web using ${providerType}. (Warning: Fallback provider ${fallbackType} failed to initialize: ${fallbackInitError.message}) Supports region-specific and localized search. Returns titles, URLs, and snippets for fast research.`
            : "Search the web using Brave Search API. Supports region-specific and localized search via country and language parameters. Returns titles, URLs, and snippets for fast research.";

  return {
    label: "Web Search",
    name: "web_search",
    description,
    parameters: WebSearchSchema,
    execute: async (_toolCallId, args) => {
      if (!primaryProvider) {
        return jsonResult({
          error: "no_provider",
          message: "No search provider configured.",
        });
      }

      const params = args as Record<string, unknown>;
      const query = readStringParam(params, "query", { required: true });
      const count =
        readNumberParam(params, "count", { integer: true }) ?? search?.maxResults ?? undefined;
      const country = readStringParam(params, "country");
      const search_lang = readStringParam(params, "search_lang");
      const ui_lang = readStringParam(params, "ui_lang");
      const rawFreshness = readStringParam(params, "freshness");

      // Freshness only supported by Brave
      if (rawFreshness && providerType !== "brave" && (!fallbackType || fallbackType !== "brave")) {
        return jsonResult({
          error: "unsupported_freshness",
          message: "freshness is only supported by the Brave web_search provider.",
          docs: "https://docs.openclaw.ai/tools/web",
        });
      }

      const freshness = rawFreshness ? normalizeFreshness(rawFreshness) : undefined;
      if (rawFreshness && !freshness) {
        return jsonResult({
          error: "invalid_freshness",
          message:
            "freshness must be one of pd, pw, pm, py, or a range like YYYY-MM-DDtoYYYY-MM-DD.",
          docs: "https://docs.openclaw.ai/tools/web",
        });
      }

      try {
        const result = await runWebSearchWithFallback(primaryProvider, fallbackProvider, {
          query,
          count: resolveSearchCount(count, DEFAULT_SEARCH_COUNT),
          timeoutSeconds: resolveTimeoutSeconds(search?.timeoutSeconds, DEFAULT_TIMEOUT_SECONDS),
          cacheTtlMs: resolveCacheTtlMs(search?.cacheTtlMinutes, DEFAULT_CACHE_TTL_MINUTES),
          country,
          search_lang,
          ui_lang,
          freshness,
        });
        // Include fallback initialization warning if present
        if (fallbackInitError && typeof result === "object" && result !== null) {
          return jsonResult({
            ...result,
            fallbackWarning: `Fallback provider ${fallbackType} failed to initialize: ${fallbackInitError.message}`,
          });
        }
        return jsonResult(result);
      } catch (error) {
        return jsonResult({
          error: "search_failed",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    },
  };
}

export const __testing = {
  normalizeFreshness,
  extractProviderConfig,
  resolveSearchProvider,
  resolveFallbackProvider,
} as const;
