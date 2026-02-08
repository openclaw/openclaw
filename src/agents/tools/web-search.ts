import { Type } from "@sinclair/typebox";
import type { OpenClawConfig } from "../../config/config.js";
import type { SearchProviderPlugin } from "../../plugins/types.js";
import type { AnyAgentTool } from "./common.js";
import { wrapWebContent } from "../../security/external-content.js";
import { jsonResult, readNumberParam, readStringParam } from "./common.js";
import {
  registerSearchProvider,
  getSearchProvider,
  hasSearchProvider,
} from "./search-providers.js";
import {
  CacheEntry,
  DEFAULT_CACHE_TTL_MINUTES,
  DEFAULT_TIMEOUT_SECONDS,
  normalizeCacheKey,
  readCache,
  readResponseText,
  resolveCacheTtlMs,
  resolveTimeoutSeconds,
  withTimeout,
  writeCache,
} from "./web-shared.js";
const DEFAULT_SEARCH_COUNT = 5;
const MAX_SEARCH_COUNT = 10;
const DEFAULT_PROVIDER = "brave";

const BRAVE_SEARCH_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";
const DEFAULT_PERPLEXITY_BASE_URL = "https://openrouter.ai/api/v1";
const PERPLEXITY_DIRECT_BASE_URL = "https://api.perplexity.ai";
const DEFAULT_PERPLEXITY_MODEL = "perplexity/sonar-pro";
const PERPLEXITY_KEY_PREFIXES = ["pplx-"];
const OPENROUTER_KEY_PREFIXES = ["sk-or-"];

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

type BraveSearchResult = {
  title?: string;
  url?: string;
  description?: string;
  age?: string;
};

type BraveSearchResponse = {
  web?: {
    results?: BraveSearchResult[];
  };
};

type PerplexityConfig = {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
};

type PerplexityApiKeySource = "config" | "perplexity_env" | "openrouter_env" | "none";

type PerplexitySearchResponse = {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
  citations?: string[];
};

type PerplexityBaseUrlHint = "direct" | "openrouter";

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

function resolveSearchApiKey(search?: WebSearchConfig): string | undefined {
  const fromConfig =
    search && "apiKey" in search && typeof search.apiKey === "string" ? search.apiKey.trim() : "";
  const fromEnv = (process.env.BRAVE_API_KEY ?? "").trim();
  return fromConfig || fromEnv || undefined;
}

function resolveSearchProvider(search?: WebSearchConfig): string {
  const raw =
    search && "provider" in search && typeof search.provider === "string"
      ? search.provider.trim().toLowerCase()
      : "";
  return raw || DEFAULT_PROVIDER;
}

function resolvePerplexityConfig(search?: WebSearchConfig): PerplexityConfig {
  if (!search || typeof search !== "object") {
    return {};
  }
  const perplexity = "perplexity" in search ? search.perplexity : undefined;
  if (!perplexity || typeof perplexity !== "object") {
    return {};
  }
  return perplexity as PerplexityConfig;
}

function resolvePerplexityApiKey(perplexity?: PerplexityConfig): {
  apiKey?: string;
  source: PerplexityApiKeySource;
} {
  const fromConfig = normalizeApiKey(perplexity?.apiKey);
  if (fromConfig) {
    return { apiKey: fromConfig, source: "config" };
  }

  const fromEnvPerplexity = normalizeApiKey(process.env.PERPLEXITY_API_KEY);
  if (fromEnvPerplexity) {
    return { apiKey: fromEnvPerplexity, source: "perplexity_env" };
  }

  const fromEnvOpenRouter = normalizeApiKey(process.env.OPENROUTER_API_KEY);
  if (fromEnvOpenRouter) {
    return { apiKey: fromEnvOpenRouter, source: "openrouter_env" };
  }

  return { apiKey: undefined, source: "none" };
}

function normalizeApiKey(key: unknown): string {
  return typeof key === "string" ? key.trim() : "";
}

function inferPerplexityBaseUrlFromApiKey(apiKey?: string): PerplexityBaseUrlHint | undefined {
  if (!apiKey) {
    return undefined;
  }
  const normalized = apiKey.toLowerCase();
  if (PERPLEXITY_KEY_PREFIXES.some((prefix) => normalized.startsWith(prefix))) {
    return "direct";
  }
  if (OPENROUTER_KEY_PREFIXES.some((prefix) => normalized.startsWith(prefix))) {
    return "openrouter";
  }
  return undefined;
}

function resolvePerplexityBaseUrl(
  perplexity?: PerplexityConfig,
  apiKeySource: PerplexityApiKeySource = "none",
  apiKey?: string,
): string {
  const fromConfig =
    perplexity && "baseUrl" in perplexity && typeof perplexity.baseUrl === "string"
      ? perplexity.baseUrl.trim()
      : "";
  if (fromConfig) {
    return fromConfig;
  }
  if (apiKeySource === "perplexity_env") {
    return PERPLEXITY_DIRECT_BASE_URL;
  }
  if (apiKeySource === "openrouter_env") {
    return DEFAULT_PERPLEXITY_BASE_URL;
  }
  if (apiKeySource === "config") {
    const inferred = inferPerplexityBaseUrlFromApiKey(apiKey);
    if (inferred === "direct") {
      return PERPLEXITY_DIRECT_BASE_URL;
    }
    if (inferred === "openrouter") {
      return DEFAULT_PERPLEXITY_BASE_URL;
    }
  }
  return DEFAULT_PERPLEXITY_BASE_URL;
}

function resolvePerplexityModel(perplexity?: PerplexityConfig): string {
  const fromConfig =
    perplexity && "model" in perplexity && typeof perplexity.model === "string"
      ? perplexity.model.trim()
      : "";
  return fromConfig || DEFAULT_PERPLEXITY_MODEL;
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

function resolveSiteName(url: string | undefined): string | undefined {
  if (!url) {
    return undefined;
  }
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

async function runPerplexitySearch(params: {
  query: string;
  apiKey: string;
  baseUrl: string;
  model: string;
  timeoutSeconds: number;
}): Promise<{ content: string; citations: string[] }> {
  const endpoint = `${params.baseUrl.replace(/\/$/, "")}/chat/completions`;

  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${params.apiKey}`,
      "HTTP-Referer": "https://openclaw.ai",
      "X-Title": "OpenClaw Web Search",
    },
    body: JSON.stringify({
      model: params.model,
      messages: [
        {
          role: "user",
          content: params.query,
        },
      ],
    }),
    signal: withTimeout(undefined, params.timeoutSeconds * 1000),
  });

  if (!res.ok) {
    const detail = await readResponseText(res);
    throw new Error(`Perplexity API error (${res.status}): ${detail || res.statusText}`);
  }

  const data = (await res.json()) as PerplexitySearchResponse;
  const content = data.choices?.[0]?.message?.content ?? "No response";
  const citations = data.citations ?? [];

  return { content, citations };
}

// =============================================================================
// Built-in Search Providers
// =============================================================================

const braveSearchProvider: SearchProviderPlugin = {
  id: "brave",
  label: "Brave Search",
  description: "Search the web using Brave Search API with region-specific and localized search.",
  async search(params, ctx) {
    const search = resolveSearchConfig(ctx.config);
    const apiKey = resolveSearchApiKey(search);
    if (!apiKey) {
      return {
        error: "missing_brave_api_key",
        message:
          "Brave Search API key is required. Set BRAVE_API_KEY env var or configure tools.web.search.apiKey.",
        provider: "brave",
      };
    }

    const freshness = params.freshness ? normalizeFreshness(params.freshness) : undefined;
    if (params.freshness && !freshness) {
      return {
        error: "invalid_freshness",
        message: "freshness must be one of pd, pw, pm, py, or a range like YYYY-MM-DDtoYYYY-MM-DD",
        provider: "brave",
      };
    }

    const cacheKey = normalizeCacheKey(
      `brave:${params.query}:${params.count}:${params.country || "default"}:${params.search_lang || "default"}:${params.ui_lang || "default"}:${freshness || "default"}`,
    );
    const cached = readCache(SEARCH_CACHE, cacheKey);
    if (cached) {
      return { ...cached.value, cached: true, query: params.query, provider: "brave" };
    }

    const start = Date.now();
    const url = new URL(BRAVE_SEARCH_ENDPOINT);
    url.searchParams.set("q", params.query);
    url.searchParams.set("count", String(params.count));
    if (params.country) {
      url.searchParams.set("country", params.country);
    }
    if (params.search_lang) {
      url.searchParams.set("search_lang", params.search_lang);
    }
    if (params.ui_lang) {
      url.searchParams.set("ui_lang", params.ui_lang);
    }
    if (freshness) {
      url.searchParams.set("freshness", freshness);
    }

    const res = await fetch(url.toString(), {
      method: "GET",
      headers: {
        Accept: "application/json",
        "X-Subscription-Token": apiKey,
      },
      signal: withTimeout(undefined, ctx.timeoutSeconds * 1000),
    });

    if (!res.ok) {
      const detail = await readResponseText(res);
      throw new Error(`Brave Search API error (${res.status}): ${detail || res.statusText}`);
    }

    const data = (await res.json()) as BraveSearchResponse;
    const results = Array.isArray(data.web?.results) ? (data.web?.results ?? []) : [];
    const mapped = results.map((entry) => {
      const description = entry.description ?? "";
      const title = entry.title ?? "";
      const url = entry.url ?? "";
      const rawSiteName = resolveSiteName(url);
      return {
        title: title ? wrapWebContent(title, "web_search") : "",
        url,
        description: description ? wrapWebContent(description, "web_search") : "",
        published: entry.age || undefined,
        siteName: rawSiteName || undefined,
      };
    });

    const payload = {
      query: params.query,
      provider: "brave",
      count: mapped.length,
      tookMs: Date.now() - start,
      results: mapped,
    };
    writeCache(SEARCH_CACHE, cacheKey, payload, ctx.cacheTtlMs);
    return payload;
  },
};

const perplexitySearchProvider: SearchProviderPlugin = {
  id: "perplexity",
  label: "Perplexity Sonar",
  description:
    "Search the web using Perplexity Sonar (direct or via OpenRouter). Returns AI-synthesized answers with citations.",
  async search(params, ctx) {
    // Perplexity doesn't support freshness filtering
    if (params.freshness) {
      return {
        error: "unsupported_freshness",
        message: "Perplexity provider does not support freshness filtering",
        provider: "perplexity",
      };
    }

    const search = resolveSearchConfig(ctx.config);
    const perplexityConfig = resolvePerplexityConfig(search);
    const perplexityAuth = resolvePerplexityApiKey(perplexityConfig);
    const apiKey = perplexityAuth?.apiKey;

    if (!apiKey) {
      return {
        error: "missing_perplexity_api_key",
        message:
          "Perplexity API key is required. Set PERPLEXITY_API_KEY or OPENROUTER_API_KEY env var, or configure tools.web.search.perplexity.apiKey.",
        provider: "perplexity",
      };
    }

    const baseUrl = resolvePerplexityBaseUrl(perplexityConfig, perplexityAuth.source, apiKey);
    const model = resolvePerplexityModel(perplexityConfig);

    const cacheKey = normalizeCacheKey(
      `perplexity:${params.query}:${params.count}:${params.country || "default"}:${params.search_lang || "default"}:${params.ui_lang || "default"}`,
    );
    const cached = readCache(SEARCH_CACHE, cacheKey);
    if (cached) {
      return { ...cached.value, cached: true, query: params.query, provider: "perplexity" };
    }

    const start = Date.now();
    const { content, citations } = await runPerplexitySearch({
      query: params.query,
      apiKey,
      baseUrl,
      model,
      timeoutSeconds: ctx.timeoutSeconds,
    });

    const payload = {
      query: params.query,
      provider: "perplexity",
      model,
      tookMs: Date.now() - start,
      content: wrapWebContent(content),
      citations,
    };
    writeCache(SEARCH_CACHE, cacheKey, payload, ctx.cacheTtlMs);
    return payload;
  },
};

// Register built-in providers (idempotent for hot-reload/test scenarios)
if (!hasSearchProvider(braveSearchProvider.id)) {
  registerSearchProvider(braveSearchProvider);
}
if (!hasSearchProvider(perplexitySearchProvider.id)) {
  registerSearchProvider(perplexitySearchProvider);
}

// =============================================================================
// Web Search Tool
// =============================================================================

export function createWebSearchTool(options?: {
  config?: OpenClawConfig;
  sandboxed?: boolean;
}): AnyAgentTool | null {
  const search = resolveSearchConfig(options?.config);
  if (!resolveSearchEnabled({ search, sandboxed: options?.sandboxed })) {
    return null;
  }

  const configuredProvider = resolveSearchProvider(search);
  let searchProvider = getSearchProvider(configuredProvider);
  let effectiveProvider = configuredProvider;

  // If provider not found, fall back to brave
  if (!searchProvider) {
    searchProvider = getSearchProvider("brave");
    effectiveProvider = "brave";
  }

  // If still not found (shouldn't happen with built-in providers), return null
  if (!searchProvider) {
    return null;
  }

  const description =
    searchProvider.description ||
    `Search the web using ${searchProvider.label || effectiveProvider}.`;

  return {
    label: "Web Search",
    name: "web_search",
    description,
    parameters: WebSearchSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const query = readStringParam(params, "query", { required: true });
      const count =
        readNumberParam(params, "count", { integer: true }) ??
        search?.maxResults ??
        DEFAULT_SEARCH_COUNT;
      const country = readStringParam(params, "country");
      const search_lang = readStringParam(params, "search_lang");
      const ui_lang = readStringParam(params, "ui_lang");
      const freshness = readStringParam(params, "freshness");

      try {
        // Use pluginId if available (set during registration), otherwise fall back to provider id
        const pluginConfigKey = searchProvider.pluginId ?? searchProvider.id;
        const result = await searchProvider.search(
          {
            query,
            count: resolveSearchCount(count, DEFAULT_SEARCH_COUNT),
            country,
            search_lang,
            ui_lang,
            freshness,
            providerConfig: search,
          },
          {
            config: options?.config ?? ({} as OpenClawConfig),
            timeoutSeconds: resolveTimeoutSeconds(search?.timeoutSeconds, DEFAULT_TIMEOUT_SECONDS),
            cacheTtlMs: resolveCacheTtlMs(search?.cacheTtlMinutes, DEFAULT_CACHE_TTL_MINUTES),
            pluginConfig: options?.config?.plugins?.entries?.[pluginConfigKey]?.config,
          },
        );
        return jsonResult(result);
      } catch (error) {
        const errorPayload: Record<string, unknown> = {
          error: "search_failed",
          provider: effectiveProvider,
          message: error instanceof Error ? error.message : String(error),
        };
        // Include configured provider if it differs from effective (fallback occurred)
        if (configuredProvider !== effectiveProvider) {
          errorPayload.configuredProvider = configuredProvider;
        }
        return jsonResult(errorPayload);
      }
    },
  };
}

export const __testing = {
  inferPerplexityBaseUrlFromApiKey,
  resolvePerplexityBaseUrl,
  normalizeFreshness,
} as const;
