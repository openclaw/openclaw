import type { OpenClawConfig } from "../../config/config.js";
import { readResponseText, resolveSiteName, withTimeout } from "./web-shared.js";

// ============================================================================
// Types
// ============================================================================

export type SearchProviderType = "brave" | "perplexity" | "serper" | "mock";

export interface WebSearchOptions {
  query: string;
  count: number;
  country?: string;
  search_lang?: string;
  ui_lang?: string;
  freshness?: string;
  timeoutSeconds: number;
  cacheTtlMs: number;
}

export interface WebSearchResult {
  query: string;
  provider: string;
  [key: string]: unknown;
}

export interface WebSearchProvider {
  /** Provider identifier (e.g., "brave", "perplexity", "serper"). */
  readonly type: SearchProviderType;

  /**
   * Execute a web search using this provider.
   * @throws Error if the search fails (for fallback handling).
   */
  search(options: WebSearchOptions): Promise<WebSearchResult>;
}

export interface ProviderContext {
  config?: OpenClawConfig;
  sandboxed?: boolean;
}

// ============================================================================
// Brave Provider
// ============================================================================

const BRAVE_SEARCH_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";

interface BraveSearchResult {
  title?: string;
  url?: string;
  description?: string;
  age?: string;
}

interface BraveSearchResponse {
  web?: {
    results?: BraveSearchResult[];
  };
}

interface BraveProviderConfig {
  apiKey?: string;
}

export class BraveProvider implements WebSearchProvider {
  readonly type = "brave" as const;

  private readonly apiKey: string;

  constructor(config: BraveProviderConfig) {
    const apiKey = this.resolveApiKey(config);
    if (!apiKey) {
      throw new Error(
        "BraveProvider requires an API key. Set tools.web.search.apiKey or BRAVE_API_KEY environment variable.",
      );
    }
    this.apiKey = apiKey;
  }

  private resolveApiKey(config: BraveProviderConfig): string | undefined {
    const fromConfig = config.apiKey?.trim() || "";
    const fromEnv = process.env.BRAVE_API_KEY?.trim() || "";
    return fromConfig || fromEnv || undefined;
  }

  async search(options: WebSearchOptions): Promise<WebSearchResult> {
    const { query, count, country, search_lang, ui_lang, freshness, timeoutSeconds } = options;

    const url = new URL(BRAVE_SEARCH_ENDPOINT);
    url.searchParams.set("q", query);
    url.searchParams.set("count", String(Math.min(10, Math.max(1, count))));
    if (country) {
      url.searchParams.set("country", country);
    }
    if (search_lang) {
      url.searchParams.set("search_lang", search_lang);
    }
    if (ui_lang) {
      url.searchParams.set("ui_lang", ui_lang);
    }
    if (freshness) {
      url.searchParams.set("freshness", freshness);
    }

    const res = await fetch(url.toString(), {
      method: "GET",
      headers: {
        Accept: "application/json",
        "X-Subscription-Token": this.apiKey,
      },
      signal: withTimeout(undefined, timeoutSeconds * 1000),
    });

    if (!res.ok) {
      const detail = await readResponseText(res);
      throw new Error(`Brave Search API error (${res.status}): ${detail || res.statusText}`);
    }

    const data = (await res.json()) as BraveSearchResponse;
    const results = Array.isArray(data.web?.results) ? data.web?.results : [];

    const start = Date.now();
    const mapped = results.map((entry) => ({
      title: entry.title ?? "",
      url: entry.url ?? "",
      description: entry.description ?? "",
      published: entry.age || undefined,
      siteName: resolveSiteName(entry.url),
    }));

    return {
      query,
      provider: this.type,
      count: mapped.length,
      tookMs: Date.now() - start,
      results: mapped,
    };
  }
}

// ============================================================================
// Perplexity Provider
// ============================================================================

const DEFAULT_PERPLEXITY_BASE_URL = "https://openrouter.ai/api/v1";
const PERPLEXITY_DIRECT_BASE_URL = "https://api.perplexity.ai";
const DEFAULT_PERPLEXITY_MODEL = "perplexity/sonar-pro";
const PERPLEXITY_KEY_PREFIXES = ["pplx-"];
const OPENROUTER_KEY_PREFIXES = ["sk-or-"];

interface PerplexitySearchResponse {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
  citations?: string[];
}

interface PerplexityProviderConfig {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
}

export class PerplexityProvider implements WebSearchProvider {
  readonly type = "perplexity" as const;

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;

  constructor(config: PerplexityProviderConfig) {
    const auth = this.resolveApiKey(config);
    if (!auth.apiKey) {
      throw new Error(
        "PerplexityProvider requires an API key. Set tools.web.search.perplexity.apiKey, PERPLEXITY_API_KEY, or OPENROUTER_API_KEY.",
      );
    }
    this.apiKey = auth.apiKey;
    this.baseUrl = this.resolveBaseUrl(config, auth.source, auth.apiKey);
    this.model = config.model?.trim() || DEFAULT_PERPLEXITY_MODEL;
  }

  private resolveApiKey(config: PerplexityProviderConfig): {
    apiKey: string;
    source: "config" | "perplexity_env" | "openrouter_env" | "none";
  } {
    const fromConfig = config.apiKey?.trim() || "";
    if (fromConfig) {
      return { apiKey: fromConfig, source: "config" };
    }

    const fromEnvPerplexity = process.env.PERPLEXITY_API_KEY?.trim() || "";
    if (fromEnvPerplexity) {
      return { apiKey: fromEnvPerplexity, source: "perplexity_env" };
    }

    const fromEnvOpenRouter = process.env.OPENROUTER_API_KEY?.trim() || "";
    if (fromEnvOpenRouter) {
      return { apiKey: fromEnvOpenRouter, source: "openrouter_env" };
    }

    return { apiKey: "", source: "none" };
  }

  private inferBaseUrlFromApiKey(apiKey: string): "direct" | "openrouter" | undefined {
    const normalized = apiKey.toLowerCase();
    if (PERPLEXITY_KEY_PREFIXES.some((prefix) => normalized.startsWith(prefix))) {
      return "direct";
    }
    if (OPENROUTER_KEY_PREFIXES.some((prefix) => normalized.startsWith(prefix))) {
      return "openrouter";
    }
    return undefined;
  }

  private resolveBaseUrl(config: PerplexityProviderConfig, source: string, apiKey: string): string {
    const fromConfig = config.baseUrl?.trim() || "";
    if (fromConfig) {
      return fromConfig;
    }

    if (source === "perplexity_env") {
      return PERPLEXITY_DIRECT_BASE_URL;
    }
    if (source === "openrouter_env") {
      return DEFAULT_PERPLEXITY_BASE_URL;
    }

    if (source === "config") {
      const inferred = this.inferBaseUrlFromApiKey(apiKey);
      if (inferred === "direct") {
        return PERPLEXITY_DIRECT_BASE_URL;
      }
      if (inferred === "openrouter") {
        return DEFAULT_PERPLEXITY_BASE_URL;
      }
    }

    return DEFAULT_PERPLEXITY_BASE_URL;
  }

  async search(options: WebSearchOptions): Promise<WebSearchResult> {
    const { query, timeoutSeconds } = options;
    const endpoint = `${this.baseUrl.replace(/\/$/, "")}/chat/completions`;

    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
        "HTTP-Referer": "https://openclaw.ai",
        "X-Title": "OpenClaw Web Search",
      },
      body: JSON.stringify({
        model: this.model,
        messages: [{ role: "user", content: query }],
      }),
      signal: withTimeout(undefined, timeoutSeconds * 1000),
    });

    if (!res.ok) {
      const detail = await readResponseText(res);
      throw new Error(`Perplexity API error (${res.status}): ${detail || res.statusText}`);
    }

    const data = (await res.json()) as PerplexitySearchResponse;
    const content = data.choices?.[0]?.message?.content ?? "No response";
    const citations = data.citations ?? [];

    const start = Date.now();
    return {
      query,
      provider: this.type,
      model: this.model,
      tookMs: Date.now() - start,
      content,
      citations,
    };
  }
}

// ============================================================================
// Serper Provider
// ============================================================================

const SERPER_API_ENDPOINT = "https://google.serper.dev/search";

interface SerperOrganicResult {
  title: string;
  link: string;
  snippet: string;
  date?: string;
}

interface SerperSearchResponse {
  organic?: SerperOrganicResult[];
  knowledgeGraph?: {
    title?: string;
    description?: string;
  };
}

interface SerperProviderConfig {
  apiKey?: string;
}

export class SerperProvider implements WebSearchProvider {
  readonly type = "serper" as const;

  private readonly apiKey: string;

  constructor(config: SerperProviderConfig) {
    const apiKey = this.resolveApiKey(config);
    if (!apiKey) {
      throw new Error(
        "SerperProvider requires an API key. Set tools.web.search.serper.apiKey in config, or SERPER_API_KEY in the Gateway environment.",
      );
    }
    this.apiKey = apiKey;
  }

  private resolveApiKey(config: SerperProviderConfig): string | undefined {
    const fromConfig = config.apiKey?.trim() || "";
    const fromEnv = process.env.SERPER_API_KEY?.trim() || "";
    return fromConfig || fromEnv || undefined;
  }

  async search(options: WebSearchOptions): Promise<WebSearchResult> {
    const { query, count, timeoutSeconds } = options;

    const res = await fetch(SERPER_API_ENDPOINT, {
      method: "POST",
      headers: {
        "X-API-KEY": this.apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        q: query,
        num: Math.min(10, Math.max(1, count)),
      }),
      signal: withTimeout(undefined, timeoutSeconds * 1000),
    });

    if (!res.ok) {
      const detail = await readResponseText(res);
      throw new Error(`Serper API error (${res.status}): ${detail || res.statusText}`);
    }

    const data = (await res.json()) as SerperSearchResponse;
    const organic = data.organic || [];
    const results = organic.slice(0, count).map((item) => ({
      title: item.title,
      url: item.link,
      description: item.snippet,
      published: item.date || undefined,
      siteName: resolveSiteName(item.link),
    }));

    const start = Date.now();
    return {
      query,
      provider: this.type,
      count: results.length,
      tookMs: Date.now() - start,
      results,
      knowledgeGraph: data.knowledgeGraph
        ? {
            title: data.knowledgeGraph.title,
            description: data.knowledgeGraph.description,
          }
        : undefined,
    };
  }
}

// ============================================================================
// Mock Provider (for testing)
// ============================================================================

export interface MockProviderConfig {
  /** Simulated delay in ms. */
  delay?: number;
  /** Whether to throw an error. */
  shouldFail?: boolean;
  /** Custom error message when shouldFail is true. */
  errorMessage?: string;
  /** Custom result function. */
  customResult?: (options: WebSearchOptions) => WebSearchResult;
}

export class MockProvider implements WebSearchProvider {
  readonly type = "mock" as const;

  private readonly config: MockProviderConfig;

  constructor(config: MockProviderConfig = {}) {
    this.config = config;
  }

  async search(options: WebSearchOptions): Promise<WebSearchResult> {
    if (this.config.delay) {
      await new Promise((resolve) => setTimeout(resolve, this.config.delay));
    }

    if (this.config.shouldFail) {
      throw new Error(this.config.errorMessage || "MockProvider failure");
    }

    if (this.config.customResult) {
      return this.config.customResult(options);
    }

    return {
      query: options.query,
      provider: "mock",
      count: options.count,
      tookMs: 0,
      results: [
        {
          title: `Mock result for: ${options.query}`,
          url: "https://example.com/mock",
          description: "This is a mock search result for testing purposes.",
        },
      ],
    };
  }
}

// ============================================================================
// Provider Factory
// ============================================================================

export type ProviderConfig = {
  type?: SearchProviderType;
  brave?: { apiKey?: string };
  perplexity?: { apiKey?: string; baseUrl?: string; model?: string };
  serper?: { apiKey?: string };
};

export function createProvider(
  providerType: SearchProviderType,
  config: ProviderConfig,
): WebSearchProvider {
  switch (providerType) {
    case "brave":
      return new BraveProvider(config.brave || {});
    case "perplexity":
      return new PerplexityProvider(config.perplexity || {});
    case "serper":
      return new SerperProvider(config.serper || {});
    case "mock":
      return new MockProvider();
    default:
      throw new Error(`Unknown provider type: ${providerType as string}`);
  }
}
