import { Type } from "@sinclair/typebox";
import { formatCliCommand } from "../../cli/command-format.js";
import type { OpenClawConfig } from "../../config/config.js";
import { normalizeResolvedSecretInputString } from "../../config/types.secrets.js";
import { logVerbose } from "../../globals.js";
import type { RuntimeWebSearchMetadata } from "../../secrets/runtime-web-tools.js";
import { wrapWebContent } from "../../security/external-content.js";
import { normalizeSecretInput } from "../../utils/normalize-secret-input.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readNumberParam, readStringArrayParam, readStringParam } from "./common.js";
import { withTrustedWebToolsEndpoint } from "./web-guarded-fetch.js";
import { resolveCitationRedirectUrl } from "./web-search-citation-redirect.js";
import {
  CacheEntry,
  DEFAULT_CACHE_TTL_MINUTES,
  DEFAULT_TIMEOUT_SECONDS,
  normalizeCacheKey,
  readCache,
  readResponseText,
  resolveCacheTtlMs,
  resolveTimeoutSeconds,
  writeCache,
} from "./web-shared.js";

const SEARCH_PROVIDERS = ["brave", "gemini", "grok", "kimi", "perplexity"] as const;
const DEFAULT_SEARCH_COUNT = 5;
const MAX_SEARCH_COUNT = 10;

const BRAVE_SEARCH_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";
const BRAVE_LLM_CONTEXT_ENDPOINT = "https://api.search.brave.com/res/v1/llm/context";
const DEFAULT_PERPLEXITY_BASE_URL = "https://openrouter.ai/api/v1";
const PERPLEXITY_DIRECT_BASE_URL = "https://api.perplexity.ai";
const PERPLEXITY_SEARCH_ENDPOINT = "https://api.perplexity.ai/search";
const DEFAULT_PERPLEXITY_MODEL = "perplexity/sonar-pro";
const PERPLEXITY_KEY_PREFIXES = ["pplx-"];
const OPENROUTER_KEY_PREFIXES = ["sk-or-"];

const XAI_API_ENDPOINT = "https://api.x.ai/v1/responses";
const DEFAULT_GROK_MODEL = "grok-4-1-fast";
const DEFAULT_KIMI_BASE_URL = "https://api.moonshot.ai/v1";
const DEFAULT_KIMI_MODEL = "moonshot-v1-128k";
const KIMI_WEB_SEARCH_TOOL = {
  type: "builtin_function",
  function: { name: "$web_search" },
} as const;

const SEARCH_CACHE = new Map<string, CacheEntry<Record<string, unknown>>>();
const BRAVE_FRESHNESS_SHORTCUTS = new Set(["pd", "pw", "pm", "py"]);
const BRAVE_FRESHNESS_RANGE = /^(\d{4}-\d{2}-\d{2})to(\d{4}-\d{2}-\d{2})$/;
const BRAVE_SEARCH_LANG_CODES = new Set([
  "ar",
  "eu",
  "bn",
  "bg",
  "ca",
  "zh-hans",
  "zh-hant",
  "hr",
  "cs",
  "da",
  "nl",
  "en",
  "en-gb",
  "et",
  "fi",
  "fr",
  "gl",
  "de",
  "el",
  "gu",
  "he",
  "hi",
  "hu",
  "is",
  "it",
  "jp",
  "kn",
  "ko",
  "lv",
  "lt",
  "ms",
  "ml",
  "mr",
  "nb",
  "pl",
  "pt-br",
  "pt-pt",
  "pa",
  "ro",
  "ru",
  "sr",
  "sk",
  "sl",
  "es",
  "sv",
  "ta",
  "te",
  "th",
  "tr",
  "uk",
  "vi",
]);
const BRAVE_SEARCH_LANG_ALIASES: Record<string, string> = {
  ja: "jp",
  zh: "zh-hans",
  "zh-cn": "zh-hans",
  "zh-hk": "zh-hant",
  "zh-sg": "zh-hans",
  "zh-tw": "zh-hant",
};
const BRAVE_UI_LANG_LOCALE = /^([a-z]{2})-([a-z]{2})$/i;
const PERPLEXITY_RECENCY_VALUES = new Set(["day", "week", "month", "year"]);

const FRESHNESS_TO_RECENCY: Record<string, string> = {
  pd: "day",
  pw: "week",
  pm: "month",
  py: "year",
};
const RECENCY_TO_FRESHNESS: Record<string, string> = {
  day: "pd",
  week: "pw",
  month: "pm",
  year: "py",
};

const ISO_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const PERPLEXITY_DATE_PATTERN = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;

function isoToPerplexityDate(iso: string): string | undefined {
  const match = iso.match(ISO_DATE_PATTERN);
  if (!match) {
    return undefined;
  }
  const [, year, month, day] = match;
  return `${parseInt(month, 10)}/${parseInt(day, 10)}/${year}`;
}

function normalizeToIsoDate(value: string): string | undefined {
  const trimmed = value.trim();
  if (ISO_DATE_PATTERN.test(trimmed)) {
    return isValidIsoDate(trimmed) ? trimmed : undefined;
  }
  const match = trimmed.match(PERPLEXITY_DATE_PATTERN);
  if (match) {
    const [, month, day, year] = match;
    const iso = `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
    return isValidIsoDate(iso) ? iso : undefined;
  }
  return undefined;
}

function createWebSearchSchema(params: {
  provider: (typeof SEARCH_PROVIDERS)[number];
  perplexityTransport?: PerplexityTransport;
}) {
  const querySchema = {
    query: Type.String({ description: "Search query string." }),
    count: Type.Optional(
      Type.Number({
        description: "Number of results to return (1-10).",
        minimum: 1,
        maximum: MAX_SEARCH_COUNT,
      }),
    ),
  } as const;

  const filterSchema = {
    country: Type.Optional(
      Type.String({
        description:
          "2-letter country code for region-specific results (e.g., 'DE', 'US', 'ALL'). Default: 'US'.",
      }),
    ),
    language: Type.Optional(
      Type.String({
        description: "ISO 639-1 language code for results (e.g., 'en', 'de', 'fr').",
      }),
    ),
    freshness: Type.Optional(
      Type.String({
        description: "Filter by time: 'day' (24h), 'week', 'month', or 'year'.",
      }),
    ),
    date_after: Type.Optional(
      Type.String({
        description: "Only results published after this date (YYYY-MM-DD).",
      }),
    ),
    date_before: Type.Optional(
      Type.String({
        description: "Only results published before this date (YYYY-MM-DD).",
      }),
    ),
  } as const;

  const perplexityStructuredFilterSchema = {
    country: Type.Optional(
      Type.String({
        description:
          "Native Perplexity Search API only. 2-letter country code for region-specific results (e.g., 'DE', 'US', 'ALL'). Default: 'US'.",
      }),
    ),
    language: Type.Optional(
      Type.String({
        description:
          "Native Perplexity Search API only. ISO 639-1 language code for results (e.g., 'en', 'de', 'fr').",
      }),
    ),
    date_after: Type.Optional(
      Type.String({
        description:
          "Native Perplexity Search API only. Only results published after this date (YYYY-MM-DD).",
      }),
    ),
    date_before: Type.Optional(
      Type.String({
        description:
          "Native Perplexity Search API only. Only results published before this date (YYYY-MM-DD).",
      }),
    ),
  } as const;

  if (params.provider === "brave") {
    return Type.Object({
      ...querySchema,
      ...filterSchema,
      search_lang: Type.Optional(
        Type.String({
          description:
            "Brave language code for search results (e.g., 'en', 'de', 'en-gb', 'zh-hans', 'zh-hant', 'pt-br').",
        }),
      ),
      ui_lang: Type.Optional(
        Type.String({
          description:
            "Locale code for UI elements in language-region format (e.g., 'en-US', 'de-DE', 'fr-FR', 'tr-TR'). Must include region subtag.",
        }),
      ),
      goggles: Type.Optional(
        Type.String({
          description:
            "Brave Goggles — index-level result filtering and ranking. Inline rules (\\n-separated) or hosted URL. Syntax: [url_pattern]$[options] — site=DOMAIN|*.TLD, inurl=PATH, boost=N, downrank=N, discard; URL wildcards go before $. Examples: '$discard\\n$site=arxiv.org\\n$site=*.edu' (trusted sources only); '/docs/*$boost=5\\n/blog/*$downrank=5' (prioritize docs over blog posts); '$boost=5,site=github.com,inurl=/blob/' (boost source code).",
        }),
      ),
    });
  }

  if (params.provider === "perplexity") {
    if (params.perplexityTransport === "chat_completions") {
      return Type.Object({
        ...querySchema,
        freshness: filterSchema.freshness,
      });
    }
    return Type.Object({
      ...querySchema,
      freshness: filterSchema.freshness,
      ...perplexityStructuredFilterSchema,
      domain_filter: Type.Optional(
        Type.Array(Type.String(), {
          description:
            "Native Perplexity Search API only. Domain filter (max 20). Allowlist: ['nature.com'] or denylist: ['-reddit.com']. Cannot mix.",
        }),
      ),
      max_tokens: Type.Optional(
        Type.Number({
          description:
            "Native Perplexity Search API only. Total content budget across all results (default: 25000, max: 1000000).",
          minimum: 1,
          maximum: 1000000,
        }),
      ),
      max_tokens_per_page: Type.Optional(
        Type.Number({
          description:
            "Native Perplexity Search API only. Max tokens extracted per page (default: 2048).",
          minimum: 1,
        }),
      ),
    });
  }

  // grok, gemini, kimi, etc.
  return Type.Object({
    ...querySchema,
    ...filterSchema,
  });
}

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

type BraveLlmContextResult = { url: string; title: string; snippets: string[] };
type BraveLlmContextResponse = {
  grounding: { generic?: BraveLlmContextResult[] };
  sources?: { url?: string; hostname?: string; date?: string }[];
};

type BraveConfig = {
  mode?: string;
};

type PerplexityConfig = {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
};

type PerplexityApiKeySource = "config" | "perplexity_env" | "openrouter_env" | "none";
type PerplexityTransport = "search_api" | "chat_completions";
type PerplexityBaseUrlHint = "direct" | "openrouter";

type GrokConfig = {
  apiKey?: string;
  model?: string;
  inlineCitations?: boolean;
};

type KimiConfig = {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
};

type GrokSearchResponse = {
  output?: Array<{
    type?: string;
    role?: string;
    text?: string; // present when type === "output_text" (top-level output_text block)
    content?: Array<{
      type?: string;
      text?: string;
      annotations?: Array<{
        type?: string;
        url?: string;
        start_index?: number;
        end_index?: number;
      }>;
    }>;
    annotations?: Array<{
      type?: string;
      url?: string;
      start_index?: number;
      end_index?: number;
    }>;
  }>;
  output_text?: string; // deprecated field - kept for backwards compatibility
  citations?: string[];
  inline_citations?: Array<{
    start_index: number;
    end_index: number;
    url: string;
  }>;
};

type KimiToolCall = {
  id?: string;
  type?: string;
  function?: {
    name?: string;
    arguments?: string;
  };
};

type KimiMessage = {
  role?: string;
  content?: string;
  reasoning_content?: string;
  tool_calls?: KimiToolCall[];
};

type KimiSearchResponse = {
  choices?: Array<{
    finish_reason?: string;
    message?: KimiMessage;
  }>;
  search_results?: Array<{
    title?: string;
    url?: string;
    content?: string;
  }>;
};

type PerplexitySearchResponse = {
  choices?: Array<{
    message?: {
      content?: string;
      annotations?: Array<{
        type?: string;
        url?: string;
        url_citation?: {
          url?: string;
          title?: string;
          start_index?: number;
          end_index?: number;
        };
      }>;
    };
  }>;
  citations?: string[];
};

type PerplexitySearchApiResult = {
  title?: string;
  url?: string;
  snippet?: string;
  date?: string;
  last_updated?: string;
};

type PerplexitySearchApiResponse = {
  results?: PerplexitySearchApiResult[];
  id?: string;
};

function extractPerplexityCitations(data: PerplexitySearchResponse): string[] {
  const normalizeUrl = (value: unknown): string | undefined => {
    if (typeof value !== "string") {
      return undefined;
    }
    const trimmed = value.trim();
    return trimmed ? trimmed : undefined;
  };

  const topLevel = (data.citations ?? [])
    .map(normalizeUrl)
    .filter((url): url is string => Boolean(url));
  if (topLevel.length > 0) {
    return [...new Set(topLevel)];
  }

  const citations: string[] = [];
  for (const choice of data.choices ?? []) {
    for (const annotation of choice.message?.annotations ?? []) {
      if (annotation.type !== "url_citation") {
        continue;
      }
      const url = normalizeUrl(annotation.url_citation?.url ?? annotation.url);
      if (url) {
        citations.push(url);
      }
    }
  }

  return [...new Set(citations)];
}

function extractGrokContent(data: GrokSearchResponse): {
  text: string | undefined;
  annotationCitations: string[];
} {
  // xAI Responses API format: find the message output with text content
  for (const output of data.output ?? []) {
    if (output.type === "message") {
      for (const block of output.content ?? []) {
        if (block.type === "output_text" && typeof block.text === "string" && block.text) {
          const urls = (block.annotations ?? [])
            .filter((a) => a.type === "url_citation" && typeof a.url === "string")
            .map((a) => a.url as string);
          return { text: block.text, annotationCitations: [...new Set(urls)] };
        }
      }
    }
    // Some xAI responses place output_text blocks directly in the output array
    // without a message wrapper.
    if (
      output.type === "output_text" &&
      "text" in output &&
      typeof output.text === "string" &&
      output.text
    ) {
      const rawAnnotations =
        "annotations" in output && Array.isArray(output.annotations) ? output.annotations : [];
      const urls = rawAnnotations
        .filter(
          (a: Record<string, unknown>) => a.type === "url_citation" && typeof a.url === "string",
        )
        .map((a: Record<string, unknown>) => a.url as string);
      return { text: output.text, annotationCitations: [...new Set(urls)] };
    }
  }
  // Fallback: deprecated output_text field
  const text = typeof data.output_text === "string" ? data.output_text : undefined;
  return { text, annotationCitations: [] };
}

type GeminiConfig = {
  apiKey?: string;
  model?: string;
};

type GeminiGroundingResponse = {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        text?: string;
      }>;
    };
    groundingMetadata?: {
      groundingChunks?: Array<{
        web?: {
          uri?: string;
          title?: string;
        };
      }>;
      searchEntryPoint?: {
        renderedContent?: string;
      };
      webSearchQueries?: string[];
    };
  }>;
  error?: {
    code?: number;
    message?: string;
    status?: string;
  };
};

const DEFAULT_GEMINI_MODEL = "gemini-2.5-flash";
const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta";

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
  const fromConfigRaw =
    search && "apiKey" in search
      ? normalizeResolvedSecretInputString({
          value: search.apiKey,
          path: "tools.web.search.apiKey",
        })
      : undefined;
  const fromConfig = normalizeSecretInput(fromConfigRaw);
  const fromEnv = normalizeSecretInput(process.env.BRAVE_API_KEY);
  return fromConfig || fromEnv || undefined;
}

function missingSearchKeyPayload(provider: (typeof SEARCH_PROVIDERS)[number]) {
  if (provider === "brave") {
    return {
      error: "missing_brave_api_key",
      message: `web_search (brave) needs a Brave Search API key. Run \`${formatCliCommand("openclaw configure --section web")}\` to store it, or set BRAVE_API_KEY in the Gateway environment.`,
      docs: "https://docs.openclaw.ai/tools/web",
    };
  }
  if (provider === "gemini") {
    return {
      error: "missing_gemini_api_key",
      message:
        "web_search (gemini) needs an API key. Set GEMINI_API_KEY in the Gateway environment, or configure tools.web.search.gemini.apiKey.",
      docs: "https://docs.openclaw.ai/tools/web",
    };
  }
  if (provider === "grok") {
    return {
      error: "missing_xai_api_key",
      message:
        "web_search (grok) needs an xAI API key. Set XAI_API_KEY in the Gateway environment, or configure tools.web.search.grok.apiKey.",
      docs: "https://docs.openclaw.ai/tools/web",
    };
  }
  if (provider === "kimi") {
    return {
      error: "missing_kimi_api_key",
      message:
        "web_search (kimi) needs a Moonshot API key. Set KIMI_API_KEY or MOONSHOT_API_KEY in the Gateway environment, or configure tools.web.search.kimi.apiKey.",
      docs: "https://docs.openclaw.ai/tools/web",
    };
  }
  return {
    error: "missing_perplexity_api_key",
    message:
      "web_search (perplexity) needs an API key. Set PERPLEXITY_API_KEY or OPENROUTER_API_KEY in the Gateway environment, or configure tools.web.search.perplexity.apiKey.",
    docs: "https://docs.openclaw.ai/tools/web",
  };
}

function resolveSearchProvider(search?: WebSearchConfig): (typeof SEARCH_PROVIDERS)[number] {
  const raw =
    search && "provider" in search && typeof search.provider === "string"
      ? search.provider.trim().toLowerCase()
      : "";
  if (raw === "brave") {
    return "brave";
  }
  if (raw === "gemini") {
    return "gemini";
  }
  if (raw === "grok") {
    return "grok";
  }
  if (raw === "kimi") {
    return "kimi";
  }
  if (raw === "perplexity") {
    return "perplexity";
  }

  // Auto-detect provider from available API keys (alphabetical order)
  if (raw === "") {
    // Brave
    if (resolveSearchApiKey(search)) {
      logVerbose(
        'web_search: no provider configured, auto-detected "brave" from available API keys',
      );
      return "brave";
    }
    // Gemini
    const geminiConfig = resolveGeminiConfig(search);
    if (resolveGeminiApiKey(geminiConfig)) {
      logVerbose(
        'web_search: no provider configured, auto-detected "gemini" from available API keys',
      );
      return "gemini";
    }
    // Grok
    const grokConfig = resolveGrokConfig(search);
    if (resolveGrokApiKey(grokConfig)) {
      logVerbose(
        'web_search: no provider configured, auto-detected "grok" from available API keys',
      );
      return "grok";
    }
    // Kimi
    const kimiConfig = resolveKimiConfig(search);
    if (resolveKimiApiKey(kimiConfig)) {
      logVerbose(
        'web_search: no provider configured, auto-detected "kimi" from available API keys',
      );
      return "kimi";
    }
    // Perplexity
    const perplexityConfig = resolvePerplexityConfig(search);
    const { apiKey: perplexityKey } = resolvePerplexityApiKey(perplexityConfig);
    if (perplexityKey) {
      logVerbose(
        'web_search: no provider configured, auto-detected "perplexity" from available API keys',
      );
      return "perplexity";
    }
  }

  return "brave";
}

function resolveBraveConfig(search?: WebSearchConfig): BraveConfig {
  if (!search || typeof search !== "object") {
    return {};
  }
  const brave = "brave" in search ? search.brave : undefined;
  if (!brave || typeof brave !== "object") {
    return {};
  }
  return brave as BraveConfig;
}

function resolveBraveMode(brave: BraveConfig): "web" | "llm-context" {
  return brave.mode === "llm-context" ? "llm-context" : "web";
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
  return normalizeSecretInput(key);
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
  authSource: PerplexityApiKeySource = "none", // pragma: allowlist secret
  configuredKey?: string,
): string {
  const fromConfig =
    perplexity && "baseUrl" in perplexity && typeof perplexity.baseUrl === "string"
      ? perplexity.baseUrl.trim()
      : "";
  if (fromConfig) {
    return fromConfig;
  }
  if (authSource === "perplexity_env") {
    return PERPLEXITY_DIRECT_BASE_URL;
  }
  if (authSource === "openrouter_env") {
    return DEFAULT_PERPLEXITY_BASE_URL;
  }
  if (authSource === "config") {
    const inferred = inferPerplexityBaseUrlFromApiKey(configuredKey);
    if (inferred === "openrouter") {
      return DEFAULT_PERPLEXITY_BASE_URL;
    }
    return PERPLEXITY_DIRECT_BASE_URL;
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

function isDirectPerplexityBaseUrl(baseUrl: string): boolean {
  const trimmed = baseUrl.trim();
  if (!trimmed) {
    return false;
  }
  try {
    return new URL(trimmed).hostname.toLowerCase() === "api.perplexity.ai";
  } catch {
    return false;
  }
}

function resolvePerplexityRequestModel(baseUrl: string, model: string): string {
  if (!isDirectPerplexityBaseUrl(baseUrl)) {
    return model;
  }
  return model.startsWith("perplexity/") ? model.slice("perplexity/".length) : model;
}

function resolvePerplexityTransport(perplexity?: PerplexityConfig): {
  apiKey?: string;
  source: PerplexityApiKeySource;
  baseUrl: string;
  model: string;
  transport: PerplexityTransport;
} {
  const auth = resolvePerplexityApiKey(perplexity);
  const baseUrl = resolvePerplexityBaseUrl(perplexity, auth.source, auth.apiKey);
  const model = resolvePerplexityModel(perplexity);
  const hasLegacyOverride = Boolean(
    (perplexity?.baseUrl && perplexity.baseUrl.trim()) ||
    (perplexity?.model && perplexity.model.trim()),
  );
  return {
    ...auth,
    baseUrl,
    model,
    transport:
      hasLegacyOverride || !isDirectPerplexityBaseUrl(baseUrl) ? "chat_completions" : "search_api",
  };
}

function resolvePerplexitySchemaTransportHint(
  perplexity?: PerplexityConfig,
): PerplexityTransport | undefined {
  const hasLegacyOverride = Boolean(
    (perplexity?.baseUrl && perplexity.baseUrl.trim()) ||
    (perplexity?.model && perplexity.model.trim()),
  );
  return hasLegacyOverride ? "chat_completions" : undefined;
}

function resolveGrokConfig(search?: WebSearchConfig): GrokConfig {
  if (!search || typeof search !== "object") {
    return {};
  }
  const grok = "grok" in search ? search.grok : undefined;
  if (!grok || typeof grok !== "object") {
    return {};
  }
  return grok as GrokConfig;
}

function resolveGrokApiKey(grok?: GrokConfig): string | undefined {
  const fromConfig = normalizeApiKey(grok?.apiKey);
  if (fromConfig) {
    return fromConfig;
  }
  const fromEnv = normalizeApiKey(process.env.XAI_API_KEY);
  return fromEnv || undefined;
}

function resolveGrokModel(grok?: GrokConfig): string {
  const fromConfig =
    grok && "model" in grok && typeof grok.model === "string" ? grok.model.trim() : "";
  return fromConfig || DEFAULT_GROK_MODEL;
}

function resolveGrokInlineCitations(grok?: GrokConfig): boolean {
  return grok?.inlineCitations === true;
}

function resolveKimiConfig(search?: WebSearchConfig): KimiConfig {
  if (!search || typeof search !== "object") {
    return {};
  }
  const kimi = "kimi" in search ? search.kimi : undefined;
  if (!kimi || typeof kimi !== "object") {
    return {};
  }
  return kimi as KimiConfig;
}

function resolveKimiApiKey(kimi?: KimiConfig): string | undefined {
  const fromConfig = normalizeApiKey(kimi?.apiKey);
  if (fromConfig) {
    return fromConfig;
  }
  const fromEnvKimi = normalizeApiKey(process.env.KIMI_API_KEY);
  if (fromEnvKimi) {
    return fromEnvKimi;
  }
  const fromEnvMoonshot = normalizeApiKey(process.env.MOONSHOT_API_KEY);
  return fromEnvMoonshot || undefined;
}

function resolveKimiModel(kimi?: KimiConfig): string {
  const fromConfig =
    kimi && "model" in kimi && typeof kimi.model === "string" ? kimi.model.trim() : "";
  return fromConfig || DEFAULT_KIMI_MODEL;
}

function resolveKimiBaseUrl(kimi?: KimiConfig): string {
  const fromConfig =
    kimi && "baseUrl" in kimi && typeof kimi.baseUrl === "string" ? kimi.baseUrl.trim() : "";
  return fromConfig || DEFAULT_KIMI_BASE_URL;
}

function resolveGeminiConfig(search?: WebSearchConfig): GeminiConfig {
  if (!search || typeof search !== "object") {
    return {};
  }
  const gemini = "gemini" in search ? search.gemini : undefined;
  if (!gemini || typeof gemini !== "object") {
    return {};
  }
  return gemini as GeminiConfig;
}

function resolveGeminiApiKey(gemini?: GeminiConfig): string | undefined {
  const fromConfig = normalizeApiKey(gemini?.apiKey);
  if (fromConfig) {
    return fromConfig;
  }
  const fromEnv = normalizeApiKey(process.env.GEMINI_API_KEY);
  return fromEnv || undefined;
}

function resolveGeminiModel(gemini?: GeminiConfig): string {
  const fromConfig =
    gemini && "model" in gemini && typeof gemini.model === "string" ? gemini.model.trim() : "";
  return fromConfig || DEFAULT_GEMINI_MODEL;
}

async function withTrustedWebSearchEndpoint<T>(
  params: {
    url: string;
    timeoutSeconds: number;
    init: RequestInit;
  },
  run: (response: Response) => Promise<T>,
): Promise<T> {
  return withTrustedWebToolsEndpoint(
    {
      url: params.url,
      init: params.init,
      timeoutSeconds: params.timeoutSeconds,
    },
    async ({ response }) => run(response),
  );
}

async function runGeminiSearch(params: {
  query: string;
  apiKey: string;
  model: string;
  timeoutSeconds: number;
}): Promise<{ content: string; citations: Array<{ url: string; title?: string }> }> {
  const endpoint = `${GEMINI_API_BASE}/models/${params.model}:generateContent`;

  return withTrustedWebSearchEndpoint(
    {
      url: endpoint,
      timeoutSeconds: params.timeoutSeconds,
      init: {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": params.apiKey,
        },
        body: JSON.stringify({
          contents: [
            {
              parts: [{ text: params.query }],
            },
          ],
          tools: [{ google_search: {} }],
        }),
      },
    },
    async (res) => {
      if (!res.ok) {
        const detailResult = await readResponseText(res, { maxBytes: 64_000 });
        // Strip API key from any error detail to prevent accidental key leakage in logs
        const safeDetail = (detailResult.text || res.statusText).replace(
          /key=[^&\s]+/gi,
          "key=***",
        );
        throw new Error(`Gemini API error (${res.status}): ${safeDetail}`);
      }

      let data: GeminiGroundingResponse;
      try {
        data = (await res.json()) as GeminiGroundingResponse;
      } catch (err) {
        const safeError = String(err).replace(/key=[^&\s]+/gi, "key=***");
        throw new Error(`Gemini API returned invalid JSON: ${safeError}`, { cause: err });
      }

      if (data.error) {
        const rawMsg = data.error.message || data.error.status || "unknown";
        const safeMsg = rawMsg.replace(/key=[^&\s]+/gi, "key=***");
        throw new Error(`Gemini API error (${data.error.code}): ${safeMsg}`);
      }

      const candidate = data.candidates?.[0];
      const content =
        candidate?.content?.parts
          ?.map((p) => p.text)
          .filter(Boolean)
          .join("\n") ?? "No response";

      const groundingChunks = candidate?.groundingMetadata?.groundingChunks ?? [];
      const rawCitations = groundingChunks
        .filter((chunk) => chunk.web?.uri)
        .map((chunk) => ({
          url: chunk.web!.uri!,
          title: chunk.web?.title || undefined,
        }));

      // Resolve Google grounding redirect URLs to direct URLs with concurrency cap.
      // Gemini typically returns 3-8 citations; cap at 10 concurrent to be safe.
      const MAX_CONCURRENT_REDIRECTS = 10;
      const citations: Array<{ url: string; title?: string }> = [];
      for (let i = 0; i < rawCitations.length; i += MAX_CONCURRENT_REDIRECTS) {
        const batch = rawCitations.slice(i, i + MAX_CONCURRENT_REDIRECTS);
        const resolved = await Promise.all(
          batch.map(async (citation) => {
            const resolvedUrl = await resolveCitationRedirectUrl(citation.url);
            return { ...citation, url: resolvedUrl };
          }),
        );
        citations.push(...resolved);
      }

      return { content, citations };
    },
  );
}

function resolveSearchCount(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  const clamped = Math.max(1, Math.min(MAX_SEARCH_COUNT, Math.floor(parsed)));
  return clamped;
}

function normalizeBraveSearchLang(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  const canonical = BRAVE_SEARCH_LANG_ALIASES[trimmed.toLowerCase()] ?? trimmed.toLowerCase();
  if (!BRAVE_SEARCH_LANG_CODES.has(canonical)) {
    return undefined;
  }
  return canonical;
}

function normalizeBraveUiLang(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  const match = trimmed.match(BRAVE_UI_LANG_LOCALE);
  if (!match) {
    return undefined;
  }
  const [, language, region] = match;
  return `${language.toLowerCase()}-${region.toUpperCase()}`;
}

function normalizeBraveLanguageParams(params: { search_lang?: string; ui_lang?: string }): {
  search_lang?: string;
  ui_lang?: string;
  invalidField?: "search_lang" | "ui_lang";
} {
  const rawSearchLang = params.search_lang?.trim() || undefined;
  const rawUiLang = params.ui_lang?.trim() || undefined;
  let searchLangCandidate = rawSearchLang;
  let uiLangCandidate = rawUiLang;

  // Recover common LLM mix-up: locale in search_lang + short code in ui_lang.
  if (normalizeBraveUiLang(rawSearchLang) && normalizeBraveSearchLang(rawUiLang)) {
    searchLangCandidate = rawUiLang;
    uiLangCandidate = rawSearchLang;
  }

  const search_lang = normalizeBraveSearchLang(searchLangCandidate);
  if (searchLangCandidate && !search_lang) {
    return { invalidField: "search_lang" };
  }

  const ui_lang = normalizeBraveUiLang(uiLangCandidate);
  if (uiLangCandidate && !ui_lang) {
    return { invalidField: "ui_lang" };
  }

  return { search_lang, ui_lang };
}

/**
 * Normalizes freshness shortcut to the provider's expected format.
 * Accepts both Brave format (pd/pw/pm/py) and Perplexity format (day/week/month/year).
 * For Brave, also accepts date ranges (YYYY-MM-DDtoYYYY-MM-DD).
 */
function normalizeFreshness(
  value: string | undefined,
  provider: (typeof SEARCH_PROVIDERS)[number],
): string | undefined {
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  const lower = trimmed.toLowerCase();

  if (BRAVE_FRESHNESS_SHORTCUTS.has(lower)) {
    return provider === "brave" ? lower : FRESHNESS_TO_RECENCY[lower];
  }

  if (PERPLEXITY_RECENCY_VALUES.has(lower)) {
    return provider === "perplexity" ? lower : RECENCY_TO_FRESHNESS[lower];
  }

  // Brave date range support
  if (provider === "brave") {
    const match = trimmed.match(BRAVE_FRESHNESS_RANGE);
    if (match) {
      const [, start, end] = match;
      if (isValidIsoDate(start) && isValidIsoDate(end) && start <= end) {
        return `${start}to${end}`;
      }
    }
  }

  return undefined;
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

async function throwWebSearchApiError(res: Response, providerLabel: string): Promise<never> {
  const detailResult = await readResponseText(res, { maxBytes: 64_000 });
  const detail = detailResult.text;
  throw new Error(`${providerLabel} API error (${res.status}): ${detail || res.statusText}`);
}

async function runPerplexitySearchApi(params: {
  query: string;
  apiKey: string;
  count: number;
  timeoutSeconds: number;
  country?: string;
  searchDomainFilter?: string[];
  searchRecencyFilter?: string;
  searchLanguageFilter?: string[];
  searchAfterDate?: string;
  searchBeforeDate?: string;
  maxTokens?: number;
  maxTokensPerPage?: number;
}): Promise<
  Array<{ title: string; url: string; description: string; published?: string; siteName?: string }>
> {
  const body: Record<string, unknown> = {
    query: params.query,
    max_results: params.count,
  };

  if (params.country) {
    body.country = params.country;
  }
  if (params.searchDomainFilter && params.searchDomainFilter.length > 0) {
    body.search_domain_filter = params.searchDomainFilter;
  }
  if (params.searchRecencyFilter) {
    body.search_recency_filter = params.searchRecencyFilter;
  }
  if (params.searchLanguageFilter && params.searchLanguageFilter.length > 0) {
    body.search_language_filter = params.searchLanguageFilter;
  }
  if (params.searchAfterDate) {
    body.search_after_date = params.searchAfterDate;
  }
  if (params.searchBeforeDate) {
    body.search_before_date = params.searchBeforeDate;
  }
  if (params.maxTokens !== undefined) {
    body.max_tokens = params.maxTokens;
  }
  if (params.maxTokensPerPage !== undefined) {
    body.max_tokens_per_page = params.maxTokensPerPage;
  }

  return withTrustedWebSearchEndpoint(
    {
      url: PERPLEXITY_SEARCH_ENDPOINT,
      timeoutSeconds: params.timeoutSeconds,
      init: {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          Authorization: `Bearer ${params.apiKey}`,
          "HTTP-Referer": "https://openclaw.ai",
          "X-Title": "OpenClaw Web Search",
        },
        body: JSON.stringify(body),
      },
    },
    async (res) => {
      if (!res.ok) {
        return await throwWebSearchApiError(res, "Perplexity Search");
      }

      const data = (await res.json()) as PerplexitySearchApiResponse;
      const results = Array.isArray(data.results) ? data.results : [];

      return results.map((entry) => {
        const title = entry.title ?? "";
        const url = entry.url ?? "";
        const snippet = entry.snippet ?? "";
        return {
          title: title ? wrapWebContent(title, "web_search") : "",
          url,
          description: snippet ? wrapWebContent(snippet, "web_search") : "",
          published: entry.date ?? undefined,
          siteName: resolveSiteName(url) || undefined,
        };
      });
    },
  );
}

async function runPerplexitySearch(params: {
  query: string;
  apiKey: string;
  baseUrl: string;
  model: string;
  timeoutSeconds: number;
  freshness?: string;
}): Promise<{ content: string; citations: string[] }> {
  const baseUrl = params.baseUrl.trim().replace(/\/$/, "");
  const endpoint = `${baseUrl}/chat/completions`;
  const model = resolvePerplexityRequestModel(baseUrl, params.model);

  const body: Record<string, unknown> = {
    model,
    messages: [
      {
        role: "user",
        content: params.query,
      },
    ],
  };

  if (params.freshness) {
    body.search_recency_filter = params.freshness;
  }

  return withTrustedWebSearchEndpoint(
    {
      url: endpoint,
      timeoutSeconds: params.timeoutSeconds,
      init: {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${params.apiKey}`,
          "HTTP-Referer": "https://openclaw.ai",
          "X-Title": "OpenClaw Web Search",
        },
        body: JSON.stringify(body),
      },
    },
    async (res) => {
      if (!res.ok) {
        return await throwWebSearchApiError(res, "Perplexity");
      }

      const data = (await res.json()) as PerplexitySearchResponse;
      const content = data.choices?.[0]?.message?.content ?? "No response";
      // Prefer top-level citations; fall back to OpenRouter-style message annotations.
      const citations = extractPerplexityCitations(data);

      return { content, citations };
    },
  );
}

async function runGrokSearch(params: {
  query: string;
  apiKey: string;
  model: string;
  timeoutSeconds: number;
  inlineCitations: boolean;
}): Promise<{
  content: string;
  citations: string[];
  inlineCitations?: GrokSearchResponse["inline_citations"];
}> {
  const body: Record<string, unknown> = {
    model: params.model,
    input: [
      {
        role: "user",
        content: params.query,
      },
    ],
    tools: [{ type: "web_search" }],
  };

  // Note: xAI's /v1/responses endpoint does not support the `include`
  // parameter (returns 400 "Argument not supported: include"). Inline
  // citations are returned automatically when available — we just parse
  // them from the response without requesting them explicitly (#12910).

  return withTrustedWebSearchEndpoint(
    {
      url: XAI_API_ENDPOINT,
      timeoutSeconds: params.timeoutSeconds,
      init: {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${params.apiKey}`,
        },
        body: JSON.stringify(body),
      },
    },
    async (res) => {
      if (!res.ok) {
        return await throwWebSearchApiError(res, "xAI");
      }

      const data = (await res.json()) as GrokSearchResponse;
      const { text: extractedText, annotationCitations } = extractGrokContent(data);
      const content = extractedText ?? "No response";
      // Prefer top-level citations; fall back to annotation-derived ones
      const citations = (data.citations ?? []).length > 0 ? data.citations! : annotationCitations;
      const inlineCitations = data.inline_citations;

      return { content, citations, inlineCitations };
    },
  );
}

function extractKimiMessageText(message: KimiMessage | undefined): string | undefined {
  const content = message?.content?.trim();
  if (content) {
    return content;
  }
  const reasoning = message?.reasoning_content?.trim();
  return reasoning || undefined;
}

function extractKimiCitations(data: KimiSearchResponse): string[] {
  const citations = (data.search_results ?? [])
    .map((entry) => entry.url?.trim())
    .filter((url): url is string => Boolean(url));

  for (const toolCall of data.choices?.[0]?.message?.tool_calls ?? []) {
    const rawArguments = toolCall.function?.arguments;
    if (!rawArguments) {
      continue;
    }
    try {
      const parsed = JSON.parse(rawArguments) as {
        search_results?: Array<{ url?: string }>;
        url?: string;
      };
      if (typeof parsed.url === "string" && parsed.url.trim()) {
        citations.push(parsed.url.trim());
      }
      for (const result of parsed.search_results ?? []) {
        if (typeof result.url === "string" && result.url.trim()) {
          citations.push(result.url.trim());
        }
      }
    } catch {
      // ignore malformed tool arguments
    }
  }

  return [...new Set(citations)];
}

function buildKimiToolResultContent(data: KimiSearchResponse): string {
  return JSON.stringify({
    search_results: (data.search_results ?? []).map((entry) => ({
      title: entry.title ?? "",
      url: entry.url ?? "",
      content: entry.content ?? "",
    })),
  });
}

async function runKimiSearch(params: {
  query: string;
  apiKey: string;
  baseUrl: string;
  model: string;
  timeoutSeconds: number;
}): Promise<{ content: string; citations: string[] }> {
  const baseUrl = params.baseUrl.trim().replace(/\/$/, "");
  const endpoint = `${baseUrl}/chat/completions`;
  const messages: Array<Record<string, unknown>> = [
    {
      role: "user",
      content: params.query,
    },
  ];
  const collectedCitations = new Set<string>();
  const MAX_ROUNDS = 3;

  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    const nextResult = await withTrustedWebSearchEndpoint(
      {
        url: endpoint,
        timeoutSeconds: params.timeoutSeconds,
        init: {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${params.apiKey}`,
          },
          body: JSON.stringify({
            model: params.model,
            messages,
            tools: [KIMI_WEB_SEARCH_TOOL],
          }),
        },
      },
      async (
        res,
      ): Promise<{ done: true; content: string; citations: string[] } | { done: false }> => {
        if (!res.ok) {
          return await throwWebSearchApiError(res, "Kimi");
        }

        const data = (await res.json()) as KimiSearchResponse;
        for (const citation of extractKimiCitations(data)) {
          collectedCitations.add(citation);
        }
        const choice = data.choices?.[0];
        const message = choice?.message;
        const text = extractKimiMessageText(message);
        const toolCalls = message?.tool_calls ?? [];

        if (choice?.finish_reason !== "tool_calls" || toolCalls.length === 0) {
          return { done: true, content: text ?? "No response", citations: [...collectedCitations] };
        }

        messages.push({
          role: "assistant",
          content: message?.content ?? "",
          ...(message?.reasoning_content
            ? {
                reasoning_content: message.reasoning_content,
              }
            : {}),
          tool_calls: toolCalls,
        });

        const toolContent = buildKimiToolResultContent(data);
        let pushedToolResult = false;
        for (const toolCall of toolCalls) {
          const toolCallId = toolCall.id?.trim();
          if (!toolCallId) {
            continue;
          }
          pushedToolResult = true;
          messages.push({
            role: "tool",
            tool_call_id: toolCallId,
            content: toolContent,
          });
        }

        if (!pushedToolResult) {
          return { done: true, content: text ?? "No response", citations: [...collectedCitations] };
        }

        return { done: false };
      },
    );

    if (nextResult.done) {
      return { content: nextResult.content, citations: nextResult.citations };
    }
  }

  return {
    content: "Search completed but no final answer was produced.",
    citations: [...collectedCitations],
  };
}

function mapBraveLlmContextResults(
  data: BraveLlmContextResponse,
): { url: string; title: string; snippets: string[]; siteName?: string }[] {
  const genericResults = Array.isArray(data.grounding?.generic) ? data.grounding.generic : [];
  return genericResults.map((entry) => ({
    url: entry.url ?? "",
    title: entry.title ?? "",
    snippets: (entry.snippets ?? []).filter((s) => typeof s === "string" && s.length > 0),
    siteName: resolveSiteName(entry.url) || undefined,
  }));
}


async function runBraveLlmContextSearch(params: {
  query: string;
  apiKey: string;
  timeoutSeconds: number;
  country?: string;
  search_lang?: string;
  freshness?: string;
  goggles?: string;
}): Promise<{
  results: Array<{
    url: string;
    title: string;
    snippets: string[];
    siteName?: string;
  }>;
  sources?: BraveLlmContextResponse["sources"];
}> {
  const url = new URL(BRAVE_LLM_CONTEXT_ENDPOINT);
  url.searchParams.set("q", params.query);
  if (params.country) {
    url.searchParams.set("country", params.country);
  }
  if (params.search_lang) {
    url.searchParams.set("search_lang", params.search_lang);
  }
  if (params.freshness) {
    url.searchParams.set("freshness", params.freshness);
  }
  if (params.goggles) {
    url.searchParams.set("goggles", params.goggles);
  }

  return withTrustedWebSearchEndpoint(
    {
      url: url.toString(),
      timeoutSeconds: params.timeoutSeconds,
      init: {
        method: "GET",
        headers: {
          Accept: "application/json",
          "X-Subscription-Token": params.apiKey,
        },
      },
    },
    async (res) => {
      if (!res.ok) {
        const detailResult = await readResponseText(res, { maxBytes: 64_000 });
        const detail = detailResult.text;
        throw new Error(`Brave LLM Context API error (${res.status}): ${detail || res.statusText}`);
      }

      const data = (await res.json()) as BraveLlmContextResponse;
      const mapped = mapBraveLlmContextResults(data);

      return { results: mapped, sources: data.sources };
    },
  );
}

async function runWebSearch(params: {
  query: string;
  count: number;
  apiKey: string;
  timeoutSeconds: number;
  cacheTtlMs: number;
  provider: (typeof SEARCH_PROVIDERS)[number];
  country?: string;
  language?: string;
  search_lang?: string;
  ui_lang?: string;
  freshness?: string;
  dateAfter?: string;
  dateBefore?: string;
  searchDomainFilter?: string[];
  maxTokens?: number;
  maxTokensPerPage?: number;
  perplexityBaseUrl?: string;
  perplexityModel?: string;
  perplexityTransport?: PerplexityTransport;
  grokModel?: string;
  grokInlineCitations?: boolean;
  geminiModel?: string;
  kimiBaseUrl?: string;
  kimiModel?: string;
  braveMode?: "web" | "llm-context";
  goggles?: string;
}): Promise<Record<string, unknown>> {
  const effectiveBraveMode = params.braveMode ?? "web";
  const providerSpecificKey =
    params.provider === "perplexity"
      ? `${params.perplexityTransport ?? "search_api"}:${params.perplexityBaseUrl ?? PERPLEXITY_DIRECT_BASE_URL}:${params.perplexityModel ?? DEFAULT_PERPLEXITY_MODEL}`
      : params.provider === "grok"
        ? `${params.grokModel ?? DEFAULT_GROK_MODEL}:${String(params.grokInlineCitations ?? false)}`
        : params.provider === "gemini"
          ? (params.geminiModel ?? DEFAULT_GEMINI_MODEL)
          : params.provider === "kimi"
            ? `${params.kimiBaseUrl ?? DEFAULT_KIMI_BASE_URL}:${params.kimiModel ?? DEFAULT_KIMI_MODEL}`
            : "";
  const cacheKey =
    normalizeCacheKey(
      params.provider === "brave" && effectiveBraveMode === "llm-context"
        ? `${params.provider}:llm-context:${params.query}:${params.country || "default"}:${params.search_lang || params.language || "default"}:${params.freshness || "default"}`
        : `${params.provider}:${effectiveBraveMode}:${params.query}:${params.count}:${params.country || "default"}:${params.search_lang || params.language || "default"}:${params.ui_lang || "default"}:${params.freshness || "default"}:${params.dateAfter || "default"}:${params.dateBefore || "default"}:${params.searchDomainFilter?.join(",") || "default"}:${params.maxTokens || "default"}:${params.maxTokensPerPage || "default"}:${providerSpecificKey}`,
    ) + `:${(params.goggles || "\0").trim()}`;
  const cached = readCache(SEARCH_CACHE, cacheKey);
  if (cached) {
    return { ...cached.value, cached: true };
  }

  const start = Date.now();

  if (params.provider === "perplexity") {
    if (params.perplexityTransport === "chat_completions") {
      const { content, citations } = await runPerplexitySearch({
        query: params.query,
        apiKey: params.apiKey,
        baseUrl: params.perplexityBaseUrl ?? DEFAULT_PERPLEXITY_BASE_URL,
        model: params.perplexityModel ?? DEFAULT_PERPLEXITY_MODEL,
        timeoutSeconds: params.timeoutSeconds,
        freshness: params.freshness,
      });

      const payload = {
        query: params.query,
        provider: params.provider,
        model: params.perplexityModel ?? DEFAULT_PERPLEXITY_MODEL,
        tookMs: Date.now() - start,
        externalContent: {
          untrusted: true,
          source: "web_search",
          provider: params.provider,
          wrapped: true,
        },
        content: wrapWebContent(content, "web_search"),
        citations,
      };
      writeCache(SEARCH_CACHE, cacheKey, payload, params.cacheTtlMs);
      return payload;
    }

    const results = await runPerplexitySearchApi({
      query: params.query,
      apiKey: params.apiKey,
      count: params.count,
      timeoutSeconds: params.timeoutSeconds,
      country: params.country,
      searchDomainFilter: params.searchDomainFilter,
      searchRecencyFilter: params.freshness,
      searchLanguageFilter: params.language ? [params.language] : undefined,
      searchAfterDate: params.dateAfter ? isoToPerplexityDate(params.dateAfter) : undefined,
      searchBeforeDate: params.dateBefore ? isoToPerplexityDate(params.dateBefore) : undefined,
      maxTokens: params.maxTokens,
      maxTokensPerPage: params.maxTokensPerPage,
    });

    const payload = {
      query: params.query,
      provider: params.provider,
      count: results.length,
      tookMs: Date.now() - start,
      externalContent: {
        untrusted: true,
        source: "web_search",
        provider: params.provider,
        wrapped: true,
      },
      results,
    };
    writeCache(SEARCH_CACHE, cacheKey, payload, params.cacheTtlMs);
    return payload;
  }

  if (params.provider === "grok") {
    const { content, citations, inlineCitations } = await runGrokSearch({
      query: params.query,
      apiKey: params.apiKey,
      model: params.grokModel ?? DEFAULT_GROK_MODEL,
      timeoutSeconds: params.timeoutSeconds,
      inlineCitations: params.grokInlineCitations ?? false,
    });

    const payload = {
      query: params.query,
      provider: params.provider,
      model: params.grokModel ?? DEFAULT_GROK_MODEL,
      tookMs: Date.now() - start,
      externalContent: {
        untrusted: true,
        source: "web_search",
        provider: params.provider,
        wrapped: true,
      },
      content: wrapWebContent(content),
      citations,
      inlineCitations,
    };
    writeCache(SEARCH_CACHE, cacheKey, payload, params.cacheTtlMs);
    return payload;
  }

  if (params.provider === "kimi") {
    const { content, citations } = await runKimiSearch({
      query: params.query,
      apiKey: params.apiKey,
      baseUrl: params.kimiBaseUrl ?? DEFAULT_KIMI_BASE_URL,
      model: params.kimiModel ?? DEFAULT_KIMI_MODEL,
      timeoutSeconds: params.timeoutSeconds,
    });

    const payload = {
      query: params.query,
      provider: params.provider,
      model: params.kimiModel ?? DEFAULT_KIMI_MODEL,
      tookMs: Date.now() - start,
      externalContent: {
        untrusted: true,
        source: "web_search",
        provider: params.provider,
        wrapped: true,
      },
      content: wrapWebContent(content),
      citations,
    };
    writeCache(SEARCH_CACHE, cacheKey, payload, params.cacheTtlMs);
    return payload;
  }

  if (params.provider === "gemini") {
    const geminiResult = await runGeminiSearch({
      query: params.query,
      apiKey: params.apiKey,
      model: params.geminiModel ?? DEFAULT_GEMINI_MODEL,
      timeoutSeconds: params.timeoutSeconds,
    });

    const payload = {
      query: params.query,
      provider: params.provider,
      model: params.geminiModel ?? DEFAULT_GEMINI_MODEL,
      tookMs: Date.now() - start, // Includes redirect URL resolution time
      externalContent: {
        untrusted: true,
        source: "web_search",
        provider: params.provider,
        wrapped: true,
      },
      content: wrapWebContent(geminiResult.content),
      citations: geminiResult.citations,
    };
    writeCache(SEARCH_CACHE, cacheKey, payload, params.cacheTtlMs);
    return payload;
  }

  if (params.provider !== "brave") {
    throw new Error("Unsupported web search provider.");
  }

  if (effectiveBraveMode === "llm-context") {
    const { results: llmResults, sources } = await runBraveLlmContextSearch({
      query: params.query,
      apiKey: params.apiKey,
      timeoutSeconds: params.timeoutSeconds,
      country: params.country,
      search_lang: params.search_lang,
      freshness: params.freshness,
      goggles: params.goggles,
    });

    const mapped = llmResults.map((entry) => ({
      title: entry.title ? wrapWebContent(entry.title, "web_search") : "",
      url: entry.url,
      snippets: entry.snippets.map((s) => wrapWebContent(s, "web_search")),
      siteName: entry.siteName,
    }));

    const payload = {
      query: params.query,
      provider: params.provider,
      mode: "llm-context" as const,
      count: mapped.length,
      tookMs: Date.now() - start,
      externalContent: {
        untrusted: true,
        source: "web_search",
        provider: params.provider,
        wrapped: true,
      },
      results: mapped,
      sources,
    };
    writeCache(SEARCH_CACHE, cacheKey, payload, params.cacheTtlMs);
    return payload;
  }

  const url = new URL(BRAVE_SEARCH_ENDPOINT);
  url.searchParams.set("q", params.query);
  url.searchParams.set("count", String(params.count));
  if (params.country) {
    url.searchParams.set("country", params.country);
  }
  if (params.search_lang || params.language) {
    url.searchParams.set("search_lang", (params.search_lang || params.language)!);
  }
  if (params.ui_lang) {
    url.searchParams.set("ui_lang", params.ui_lang);
  }
  if (params.freshness) {
    url.searchParams.set("freshness", params.freshness);
  } else if (params.dateAfter && params.dateBefore) {
    url.searchParams.set("freshness", `${params.dateAfter}to${params.dateBefore}`);
  } else if (params.dateAfter) {
    url.searchParams.set(
      "freshness",
      `${params.dateAfter}to${new Date().toISOString().slice(0, 10)}`,
    );
  } else if (params.dateBefore) {
    url.searchParams.set("freshness", `1970-01-01to${params.dateBefore}`);
  }
  if (params.goggles) {
    url.searchParams.set("goggles", params.goggles);
  }

  const mapped = await withTrustedWebSearchEndpoint(
    {
      url: url.toString(),
      timeoutSeconds: params.timeoutSeconds,
      init: {
        method: "GET",
        headers: {
          Accept: "application/json",
          "X-Subscription-Token": params.apiKey,
        },
      },
    },
    async (res) => {
      if (!res.ok) {
        const detailResult = await readResponseText(res, { maxBytes: 64_000 });
        const detail = detailResult.text;
        throw new Error(`Brave Search API error (${res.status}): ${detail || res.statusText}`);
      }

      const data = (await res.json()) as BraveSearchResponse;
      const results = Array.isArray(data.web?.results) ? (data.web?.results ?? []) : [];
      return results.map((entry) => {
        const description = entry.description ?? "";
        const title = entry.title ?? "";
        const url = entry.url ?? "";
        const rawSiteName = resolveSiteName(url);
        return {
          title: title ? wrapWebContent(title, "web_search") : "",
          url, // Keep raw for tool chaining
          description: description ? wrapWebContent(description, "web_search") : "",
          published: entry.age || undefined,
          siteName: rawSiteName || undefined,
        };
      });
    },
  );

  const payload = {
    query: params.query,
    provider: params.provider,
    count: mapped.length,
    tookMs: Date.now() - start,
    externalContent: {
      untrusted: true,
      source: "web_search",
      provider: params.provider,
      wrapped: true,
    },
    results: mapped,
  };
  writeCache(SEARCH_CACHE, cacheKey, payload, params.cacheTtlMs);
  return payload;
}

export function createWebSearchTool(options?: {
  config?: OpenClawConfig;
  sandboxed?: boolean;
  runtimeWebSearch?: RuntimeWebSearchMetadata;
}): AnyAgentTool | null {
  const search = resolveSearchConfig(options?.config);
  if (!resolveSearchEnabled({ search, sandboxed: options?.sandboxed })) {
    return null;
  }

  const provider =
    options?.runtimeWebSearch?.selectedProvider ??
    options?.runtimeWebSearch?.providerConfigured ??
    resolveSearchProvider(search);
  const perplexityConfig = resolvePerplexityConfig(search);
  const perplexitySchemaTransportHint =
    options?.runtimeWebSearch?.perplexityTransport ??
    resolvePerplexitySchemaTransportHint(perplexityConfig);
  const grokConfig = resolveGrokConfig(search);
  const geminiConfig = resolveGeminiConfig(search);
  const kimiConfig = resolveKimiConfig(search);
  const braveConfig = resolveBraveConfig(search);
  const braveMode = resolveBraveMode(braveConfig);

  const description =
    provider === "perplexity"
      ? perplexitySchemaTransportHint === "chat_completions"
        ? "Search the web using Perplexity Sonar via Perplexity/OpenRouter chat completions. Returns AI-synthesized answers with citations from web-grounded search."
        : "Search the web using Perplexity. Runtime routing decides between native Search API and Sonar chat-completions compatibility. Structured filters are available on the native Search API path."
      : provider === "grok"
        ? "Search the web using xAI Grok. Returns AI-synthesized answers with citations from real-time web search."
        : provider === "kimi"
          ? "Search the web using Kimi by Moonshot. Returns AI-synthesized answers with citations from native $web_search."
          : provider === "gemini"
            ? "Search the web using Gemini with Google Search grounding. Returns AI-synthesized answers with citations from Google Search."
            : braveMode === "llm-context"
              ? "Search the web using Brave Search LLM Context API. Returns pre-extracted page content (text chunks, tables, code blocks) optimized for LLM grounding."
              : "Search the web using Brave Search API. Supports region-specific and localized search via country and language parameters. Returns titles, URLs, and snippets for fast research.";

  return {
    label: "Web Search",
    name: "web_search",
    description,
    parameters: createWebSearchSchema({
      provider,
      perplexityTransport: provider === "perplexity" ? perplexitySchemaTransportHint : undefined,
    }),
    execute: async (_toolCallId, args) => {
      // Resolve Perplexity auth/transport lazily at execution time so unrelated providers
      // do not touch Perplexity-only credential surfaces during tool construction.
      const perplexityRuntime =
        provider === "perplexity" ? resolvePerplexityTransport(perplexityConfig) : undefined;
      const apiKey =
        provider === "perplexity"
          ? perplexityRuntime?.apiKey
          : provider === "grok"
            ? resolveGrokApiKey(grokConfig)
            : provider === "kimi"
              ? resolveKimiApiKey(kimiConfig)
              : provider === "gemini"
                ? resolveGeminiApiKey(geminiConfig)
                : resolveSearchApiKey(search);

      if (!apiKey) {
        return jsonResult(missingSearchKeyPayload(provider));
      }

      const supportsStructuredPerplexityFilters =
        provider === "perplexity" && perplexityRuntime?.transport === "search_api";
      const params = args as Record<string, unknown>;
      const query = readStringParam(params, "query", { required: true });
      const count =
        readNumberParam(params, "count", { integer: true }) ?? search?.maxResults ?? undefined;
      const country = readStringParam(params, "country");
      if (
        country &&
        provider !== "brave" &&
        !(provider === "perplexity" && supportsStructuredPerplexityFilters)
      ) {
        return jsonResult({
          error: "unsupported_country",
          message:
            provider === "perplexity"
              ? "country filtering is only supported by the native Perplexity Search API path. Remove Perplexity baseUrl/model overrides or use a direct PERPLEXITY_API_KEY to enable it."
              : `country filtering is not supported by the ${provider} provider. Only Brave and Perplexity support country filtering.`,
          docs: "https://docs.openclaw.ai/tools/web",
        });
      }
      const language = readStringParam(params, "language");
      if (
        language &&
        provider !== "brave" &&
        !(provider === "perplexity" && supportsStructuredPerplexityFilters)
      ) {
        return jsonResult({
          error: "unsupported_language",
          message:
            provider === "perplexity"
              ? "language filtering is only supported by the native Perplexity Search API path. Remove Perplexity baseUrl/model overrides or use a direct PERPLEXITY_API_KEY to enable it."
              : `language filtering is not supported by the ${provider} provider. Only Brave and Perplexity support language filtering.`,
          docs: "https://docs.openclaw.ai/tools/web",
        });
      }
      if (language && provider === "perplexity" && !/^[a-z]{2}$/i.test(language)) {
        return jsonResult({
          error: "invalid_language",
          message: "language must be a 2-letter ISO 639-1 code like 'en', 'de', or 'fr'.",
          docs: "https://docs.openclaw.ai/tools/web",
        });
      }
      const search_lang = readStringParam(params, "search_lang");
      const ui_lang = readStringParam(params, "ui_lang");
      // For Brave, accept both `language` (unified) and `search_lang`
      const normalizedBraveLanguageParams =
        provider === "brave"
          ? normalizeBraveLanguageParams({ search_lang: search_lang || language, ui_lang })
          : { search_lang: language, ui_lang };
      if (normalizedBraveLanguageParams.invalidField === "search_lang") {
        return jsonResult({
          error: "invalid_search_lang",
          message:
            "search_lang must be a Brave-supported language code like 'en', 'en-gb', 'zh-hans', or 'zh-hant'.",
          docs: "https://docs.openclaw.ai/tools/web",
        });
      }
      if (normalizedBraveLanguageParams.invalidField === "ui_lang") {
        return jsonResult({
          error: "invalid_ui_lang",
          message: "ui_lang must be a language-region locale like 'en-US'.",
          docs: "https://docs.openclaw.ai/tools/web",
        });
      }
      const resolvedSearchLang = normalizedBraveLanguageParams.search_lang;
      const resolvedUiLang = normalizedBraveLanguageParams.ui_lang;
      if (resolvedUiLang && provider === "brave" && braveMode === "llm-context") {
        return jsonResult({
          error: "unsupported_ui_lang",
          message:
            "ui_lang is not supported by Brave llm-context mode. Remove ui_lang or use Brave web mode for locale-based UI hints.",
          docs: "https://docs.openclaw.ai/tools/web",
        });
      }
      const goggles = readStringParam(params, "goggles");
      // Defense-in-depth: goggles is not in the schema for non-Brave providers, so
      // schema validation strips it before reaching here. This guard catches any
      // caller that bypasses schema validation (e.g. raw programmatic invocation).
      if (goggles && provider !== "brave") {
        return jsonResult({
          error: "unsupported_goggles",
          message: `goggles is not supported by the ${provider} provider. Goggles are only available with Brave Search.`,
          docs: "https://docs.openclaw.ai/tools/web",
        });
      }
      const rawFreshness = readStringParam(params, "freshness");
      if (rawFreshness && provider !== "brave" && provider !== "perplexity") {
        return jsonResult({
          error: "unsupported_freshness",
          message: `freshness filtering is not supported by the ${provider} provider. Only Brave and Perplexity support freshness.`,
          docs: "https://docs.openclaw.ai/tools/web",
        });
      }
      if (rawFreshness && provider === "brave" && braveMode === "llm-context") {
        return jsonResult({
          error: "unsupported_freshness",
          message:
            "freshness filtering is not supported by Brave llm-context mode. Remove freshness or use Brave web mode.",
          docs: "https://docs.openclaw.ai/tools/web",
        });
      }
      const freshness = rawFreshness ? normalizeFreshness(rawFreshness, provider) : undefined;
      if (rawFreshness && !freshness) {
        return jsonResult({
          error: "invalid_freshness",
          message: "freshness must be day, week, month, or year.",
          docs: "https://docs.openclaw.ai/tools/web",
        });
      }
      const rawDateAfter = readStringParam(params, "date_after");
      const rawDateBefore = readStringParam(params, "date_before");
      if (rawFreshness && (rawDateAfter || rawDateBefore)) {
        return jsonResult({
          error: "conflicting_time_filters",
          message:
            "freshness and date_after/date_before cannot be used together. Use either freshness (day/week/month/year) or a date range (date_after/date_before), not both.",
          docs: "https://docs.openclaw.ai/tools/web",
        });
      }
      if (
        (rawDateAfter || rawDateBefore) &&
        provider !== "brave" &&
        !(provider === "perplexity" && supportsStructuredPerplexityFilters)
      ) {
        return jsonResult({
          error: "unsupported_date_filter",
          message:
            provider === "perplexity"
              ? "date_after/date_before are only supported by the native Perplexity Search API path. Remove Perplexity baseUrl/model overrides or use a direct PERPLEXITY_API_KEY to enable them."
              : `date_after/date_before filtering is not supported by the ${provider} provider. Only Brave and Perplexity support date filtering.`,
          docs: "https://docs.openclaw.ai/tools/web",
        });
      }
      if ((rawDateAfter || rawDateBefore) && provider === "brave" && braveMode === "llm-context") {
        return jsonResult({
          error: "unsupported_date_filter",
          message:
            "date_after/date_before filtering is not supported by Brave llm-context mode. Use Brave web mode for date filters.",
          docs: "https://docs.openclaw.ai/tools/web",
        });
      }
      const dateAfter = rawDateAfter ? normalizeToIsoDate(rawDateAfter) : undefined;
      if (rawDateAfter && !dateAfter) {
        return jsonResult({
          error: "invalid_date",
          message: "date_after must be YYYY-MM-DD format.",
          docs: "https://docs.openclaw.ai/tools/web",
        });
      }
      const dateBefore = rawDateBefore ? normalizeToIsoDate(rawDateBefore) : undefined;
      if (rawDateBefore && !dateBefore) {
        return jsonResult({
          error: "invalid_date",
          message: "date_before must be YYYY-MM-DD format.",
          docs: "https://docs.openclaw.ai/tools/web",
        });
      }
      if (dateAfter && dateBefore && dateAfter > dateBefore) {
        return jsonResult({
          error: "invalid_date_range",
          message: "date_after must be before date_before.",
          docs: "https://docs.openclaw.ai/tools/web",
        });
      }
      const domainFilter = readStringArrayParam(params, "domain_filter");
      if (
        domainFilter &&
        domainFilter.length > 0 &&
        !(provider === "perplexity" && supportsStructuredPerplexityFilters)
      ) {
        return jsonResult({
          error: "unsupported_domain_filter",
          message:
            provider === "perplexity"
              ? "domain_filter is only supported by the native Perplexity Search API path. Remove Perplexity baseUrl/model overrides or use a direct PERPLEXITY_API_KEY to enable it."
              : `domain_filter is not supported by the ${provider} provider. Only Perplexity supports domain filtering.`,
          docs: "https://docs.openclaw.ai/tools/web",
        });
      }

      if (domainFilter && domainFilter.length > 0) {
        const hasDenylist = domainFilter.some((d) => d.startsWith("-"));
        const hasAllowlist = domainFilter.some((d) => !d.startsWith("-"));
        if (hasDenylist && hasAllowlist) {
          return jsonResult({
            error: "invalid_domain_filter",
            message:
              "domain_filter cannot mix allowlist and denylist entries. Use either all positive entries (allowlist) or all entries prefixed with '-' (denylist).",
            docs: "https://docs.openclaw.ai/tools/web",
          });
        }
        if (domainFilter.length > 20) {
          return jsonResult({
            error: "invalid_domain_filter",
            message: "domain_filter supports a maximum of 20 domains.",
            docs: "https://docs.openclaw.ai/tools/web",
          });
        }
      }

      const maxTokens = readNumberParam(params, "max_tokens", { integer: true });
      const maxTokensPerPage = readNumberParam(params, "max_tokens_per_page", { integer: true });
      if (
        provider === "perplexity" &&
        perplexityRuntime?.transport === "chat_completions" &&
        (maxTokens !== undefined || maxTokensPerPage !== undefined)
      ) {
        return jsonResult({
          error: "unsupported_content_budget",
          message:
            "max_tokens and max_tokens_per_page are only supported by the native Perplexity Search API path. Remove Perplexity baseUrl/model overrides or use a direct PERPLEXITY_API_KEY to enable them.",
          docs: "https://docs.openclaw.ai/tools/web",
        });
      }

      const result = await runWebSearch({
        query,
        count: resolveSearchCount(count, DEFAULT_SEARCH_COUNT),
        apiKey,
        timeoutSeconds: resolveTimeoutSeconds(search?.timeoutSeconds, DEFAULT_TIMEOUT_SECONDS),
        cacheTtlMs: resolveCacheTtlMs(search?.cacheTtlMinutes, DEFAULT_CACHE_TTL_MINUTES),
        provider,
        country,
        language,
        search_lang: resolvedSearchLang,
        ui_lang: resolvedUiLang,
        freshness,
        dateAfter,
        dateBefore,
        searchDomainFilter: domainFilter,
        maxTokens: maxTokens ?? undefined,
        maxTokensPerPage: maxTokensPerPage ?? undefined,
        perplexityBaseUrl: perplexityRuntime?.baseUrl,
        perplexityModel: perplexityRuntime?.model,
        perplexityTransport: perplexityRuntime?.transport,
        grokModel: resolveGrokModel(grokConfig),
        grokInlineCitations: resolveGrokInlineCitations(grokConfig),
        geminiModel: resolveGeminiModel(geminiConfig),
        kimiBaseUrl: resolveKimiBaseUrl(kimiConfig),
        kimiModel: resolveKimiModel(kimiConfig),
        braveMode,
        goggles,
      });
      return jsonResult(result);
    },
  };
}

export const __testing = {
  resolveSearchProvider,
  inferPerplexityBaseUrlFromApiKey,
  resolvePerplexityBaseUrl,
  resolvePerplexityModel,
  resolvePerplexityTransport,
  isDirectPerplexityBaseUrl,
  resolvePerplexityRequestModel,
  resolvePerplexityApiKey,
  normalizeBraveLanguageParams,
  normalizeFreshness,
  normalizeToIsoDate,
  isoToPerplexityDate,
  SEARCH_CACHE,
  FRESHNESS_TO_RECENCY,
  RECENCY_TO_FRESHNESS,
  resolveGrokApiKey,
  resolveGrokModel,
  resolveGrokInlineCitations,
  extractGrokContent,
  resolveKimiApiKey,
  resolveKimiModel,
  resolveKimiBaseUrl,
  extractKimiCitations,
  resolveRedirectUrl: resolveCitationRedirectUrl,
  resolveBraveMode,
  mapBraveLlmContextResults,
  createWebSearchSchema,
} as const;
