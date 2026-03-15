import { Type } from "@sinclair/typebox";
import { formatCliCommand as _formatCliCommand } from "../../cli/command-format.js";
import type { OpenClawConfig } from "../../config/config.js";
import { normalizeResolvedSecretInputString } from "../../config/types.secrets.js";
import { logVerbose } from "../../globals.js";
import { resolveCapabilitySlotSelection } from "../../plugins/capability-slots.js";
import { loadOpenClawPlugins } from "../../plugins/loader.js";
import { getActivePluginRegistry } from "../../plugins/runtime.js";
import type {
  SearchProviderContext,
  SearchProviderErrorResult,
  SearchProviderPlugin,
  SearchProviderRequest,
  SearchProviderSuccessResult,
} from "../../plugins/types.js";
import type { RuntimeWebSearchMetadata } from "../../secrets/runtime-web-tools.js";
import { wrapWebContent } from "../../security/external-content.js";
import { normalizeSecretInput } from "../../utils/normalize-secret-input.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readNumberParam, readStringArrayParam, readStringParam } from "./common.js";
import { withTrustedWebToolsEndpoint } from "./web-guarded-fetch.js";
import { resolveCitationRedirectUrl } from "./web-search-citation-redirect.js";
import {
  type BuiltinWebSearchProviderId,
  isBuiltinWebSearchProviderId as isBuiltinWebSearchProviderIdFromCatalog,
} from "./web-search-provider-catalog.js";
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

const DEFAULT_SEARCH_COUNT = 5;
const MAX_SEARCH_COUNT = 10;
const DEFAULT_PROVIDER = "brave";

const _BRAVE_SEARCH_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";
const _BRAVE_LLM_CONTEXT_ENDPOINT = "https://api.search.brave.com/res/v1/llm/context";
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

const SEARCH_QUERY_SCHEMA_FIELDS = {
  query: Type.String({ description: "Search query string." }),
  count: Type.Optional(
    Type.Number({
      description: "Number of results to return (1-10).",
      minimum: 1,
      maximum: MAX_SEARCH_COUNT,
    }),
  ),
} as const;

const SEARCH_FILTER_SCHEMA_FIELDS = {
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

const SEARCH_PLUGIN_EXTENSION_FIELDS = {
  search_lang: Type.Optional(
    Type.String({
      description: "Optional provider-specific search language override.",
    }),
  ),
  ui_lang: Type.Optional(
    Type.String({
      description: "Optional provider-specific UI locale override.",
    }),
  ),
  domain_filter: Type.Optional(
    Type.Array(Type.String(), {
      description: "Optional provider-specific domain allow/deny filter.",
    }),
  ),
  max_tokens: Type.Optional(
    Type.Number({
      description: "Optional provider-specific content budget.",
      minimum: 1,
    }),
  ),
  max_tokens_per_page: Type.Optional(
    Type.Number({
      description: "Optional provider-specific per-page content budget.",
      minimum: 1,
    }),
  ),
} as const;

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
  provider: BuiltinWebSearchProviderId;
  perplexityTransport?: PerplexityTransport;
}) {
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
      ...SEARCH_QUERY_SCHEMA_FIELDS,
      ...SEARCH_FILTER_SCHEMA_FIELDS,
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
    });
  }

  if (params.provider === "perplexity") {
    if (params.perplexityTransport === "chat_completions") {
      return Type.Object({
        ...SEARCH_QUERY_SCHEMA_FIELDS,
        freshness: SEARCH_FILTER_SCHEMA_FIELDS.freshness,
      });
    }
    return Type.Object({
      ...SEARCH_QUERY_SCHEMA_FIELDS,
      freshness: SEARCH_FILTER_SCHEMA_FIELDS.freshness,
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
    ...SEARCH_QUERY_SCHEMA_FIELDS,
    ...SEARCH_FILTER_SCHEMA_FIELDS,
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

type _BraveSearchResponse = {
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

const _DEFAULT_GEMINI_MODEL = "gemini-2.5-flash";
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

function resolveBuiltinSearchProvider(search?: WebSearchConfig): BuiltinWebSearchProviderId {
  const raw =
    search && "provider" in search && typeof search.provider === "string"
      ? search.provider.trim().toLowerCase()
      : "";
  if (isBuiltinSearchProviderId(raw)) {
    return raw;
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

async function _runGeminiSearch(params: {
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
  provider: BuiltinWebSearchProviderId,
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

async function _runPerplexitySearchApi(params: {
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

async function _runPerplexitySearch(params: {
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

async function _runGrokSearch(params: {
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

async function _runKimiSearch(params: {
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

async function _runBraveLlmContextSearch(params: {
  query: string;
  apiKey: string;
  timeoutSeconds: number;
  country?: string;
  search_lang?: string;
  freshness?: string;
}): Promise<{
  results: Array<{
    url: string;
    title: string;
    snippets: string[];
    siteName?: string;
  }>;
  sources?: BraveLlmContextResponse["sources"];
}> {
  const url = new URL(_BRAVE_LLM_CONTEXT_ENDPOINT);
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

function normalizeSearchProviderId(value: string | undefined): string {
  return value?.trim().toLowerCase() ?? "";
}

function isBuiltinSearchProviderId(value: string): value is BuiltinWebSearchProviderId {
  return isBuiltinWebSearchProviderIdFromCatalog(value);
}

function stableSerializeForCache(value: unknown): string {
  if (value === null || value === undefined) {
    return String(value);
  }
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableSerializeForCache(entry)).join(",")}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).toSorted(([a], [b]) =>
      a.localeCompare(b),
    );
    return `{${entries
      .map(([key, entryValue]) => `${JSON.stringify(key)}:${stableSerializeForCache(entryValue)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function buildSearchRequestCacheIdentity(params: {
  query: string;
  count: number;
  country?: string;
  language?: string;
  search_lang?: string;
  ui_lang?: string;
  freshness?: string;
  dateAfter?: string;
  dateBefore?: string;
  domainFilter?: string[];
  maxTokens?: number;
  maxTokensPerPage?: number;
}): string {
  return [
    params.query,
    params.count,
    params.country || "default",
    params.language || "default",
    params.search_lang || "default",
    params.ui_lang || "default",
    params.freshness || "default",
    params.dateAfter || "default",
    params.dateBefore || "default",
    params.domainFilter?.join(",") || "default",
    params.maxTokens || "default",
    params.maxTokensPerPage || "default",
  ].join(":");
}

function createExtensibleWebSearchSchema() {
  return Type.Object({
    ...SEARCH_QUERY_SCHEMA_FIELDS,
    ...SEARCH_FILTER_SCHEMA_FIELDS,
    ...SEARCH_PLUGIN_EXTENSION_FIELDS,
  });
}

function sanitizeSearchUrl(url: unknown): string | undefined {
  if (typeof url !== "string" || url.trim() === "") {
    return undefined;
  }
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      return parsed.href;
    }
  } catch {
    // Ignore invalid URLs from plugin providers.
  }
  return undefined;
}

function createMissingSearchProviderPlugin(providerId: string): SearchProviderPlugin {
  return {
    id: providerId,
    name: providerId,
    description: `Search provider "${providerId}" is configured but not registered.`,
    search: async () => ({
      error: "unknown_search_provider",
      message: `Configured web search provider "${providerId}" is not registered.`,
      docs: "https://docs.openclaw.ai/tools/web",
    }),
  };
}

function executePluginSearchProvider(params: {
  provider: SearchProviderPlugin;
  request: SearchProviderRequest;
  context: SearchProviderContext;
}): Promise<Record<string, unknown>> {
  if (params.provider.pluginOwnedExecution) {
    return params.provider.search(params.request, params.context).then((result) => {
      if ("error" in result && typeof result.error === "string") {
        const errorResult: SearchProviderErrorResult = result;
        return {
          ...errorResult,
          provider: params.provider.id,
          ...(typeof errorResult.message === "string"
            ? {}
            : {
                message: `Search provider "${params.provider.id}" returned error "${errorResult.error}".`,
              }),
        };
      }
      return result as Record<string, unknown>;
    });
  }

  const pluginConfigKey = params.context.pluginConfig
    ? stableSerializeForCache(params.context.pluginConfig)
    : "no-plugin-config";
  const cacheKey = normalizeCacheKey(
    `${params.provider.id}:${params.provider.pluginId || "builtin"}:${pluginConfigKey}:${buildSearchRequestCacheIdentity(
      {
        query: params.request.query,
        count: params.request.count,
        country: params.request.country,
        language: params.request.language,
        search_lang: params.request.search_lang,
        ui_lang: params.request.ui_lang,
        freshness: params.request.freshness,
        dateAfter: params.request.dateAfter,
        dateBefore: params.request.dateBefore,
        domainFilter: params.request.domainFilter,
        maxTokens: params.request.maxTokens,
        maxTokensPerPage: params.request.maxTokensPerPage,
      },
    )}`,
  );
  const cached = readCache(SEARCH_CACHE, cacheKey);
  if (cached) {
    return Promise.resolve({ ...cached.value, cached: true });
  }

  const startedAt = Date.now();
  return params.provider
    .search(params.request, params.context)
    .then((result) => {
      if ("error" in result && typeof result.error === "string") {
        const errorResult: SearchProviderErrorResult = result;
        return {
          ...errorResult,
          provider: params.provider.id,
          ...(typeof errorResult.message === "string"
            ? {}
            : {
                message: `Search provider "${params.provider.id}" returned error "${errorResult.error}".`,
              }),
        };
      }

      const successResult: SearchProviderSuccessResult = result;
      const rawResults = Array.isArray(successResult.results)
        ? successResult.results.filter((entry) => entry && typeof entry === "object")
        : [];
      const normalizedResults = rawResults
        .map((entry) => {
          const value = entry as Record<string, unknown>;
          const url = sanitizeSearchUrl(value.url);
          if (!url) {
            return undefined;
          }
          const title =
            typeof value.title === "string" ? wrapWebContent(value.title, "web_search") : "";
          const description =
            typeof value.description === "string"
              ? wrapWebContent(value.description, "web_search")
              : undefined;
          const published = typeof value.published === "string" ? value.published : undefined;
          return { title, url, description, published };
        })
        .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));

      const rawCitations = Array.isArray(successResult.citations) ? successResult.citations : [];
      const normalizedCitations = rawCitations
        .map((citation) => {
          if (typeof citation === "string") {
            return sanitizeSearchUrl(citation);
          }
          if (!citation || typeof citation !== "object") {
            return undefined;
          }
          const value = citation as Record<string, unknown>;
          const url = sanitizeSearchUrl(value.url);
          if (!url) {
            return undefined;
          }
          const title =
            typeof value.title === "string" ? wrapWebContent(value.title, "web_search") : undefined;
          return title ? { url, title } : { url };
        })
        .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));

      const payload: Record<string, unknown> = {
        query: params.request.query,
        provider: params.provider.id,
        tookMs:
          typeof successResult.tookMs === "number" && Number.isFinite(successResult.tookMs)
            ? successResult.tookMs
            : Date.now() - startedAt,
        externalContent: {
          untrusted: true,
          source: "web_search",
          provider: params.provider.id,
          wrapped: true,
        },
      };
      if (normalizedResults.length > 0) {
        payload.results = normalizedResults;
        payload.count = normalizedResults.length;
      }
      if (typeof successResult.content === "string") {
        payload.content = wrapWebContent(successResult.content, "web_search");
      }
      if (normalizedCitations.length > 0) {
        payload.citations = normalizedCitations;
      }
      writeCache(SEARCH_CACHE, cacheKey, payload, params.context.cacheTtlMs);
      return payload;
    })
    .catch((error) => ({
      error: "search_failed",
      provider: params.provider.id,
      message: error instanceof Error ? error.message : String(error),
    }));
}

function getRegisteredSearchProviders(config?: OpenClawConfig): SearchProviderPlugin[] {
  let registry = getActivePluginRegistry();
  if (!registry || registry.searchProviders.length === 0) {
    registry = loadOpenClawPlugins({ config });
  }
  return registry.searchProviders.map((entry) => entry.provider);
}

function resolveBuiltinSchemaProviderId(
  provider: SearchProviderPlugin,
): BuiltinWebSearchProviderId | undefined {
  const candidate = normalizeSearchProviderId(provider.id);
  return isBuiltinSearchProviderId(candidate) ? candidate : undefined;
}

function resolveConfiguredSearchProviderId(params: {
  config?: OpenClawConfig;
  search?: WebSearchConfig;
}): string | null | undefined {
  if (params.config) {
    return resolveCapabilitySlotSelection(params.config, "providers.search");
  }
  if (!params.search) {
    return undefined;
  }
  return resolveCapabilitySlotSelection(
    { tools: { web: { search: params.search } } } as OpenClawConfig,
    "providers.search",
  );
}

function resolvePreferredBuiltinSearchProvider(params: {
  search?: WebSearchConfig;
  runtimeWebSearch?: RuntimeWebSearchMetadata;
  config?: OpenClawConfig;
}): BuiltinWebSearchProviderId {
  const configuredProviderId = normalizeSearchProviderId(
    resolveConfiguredSearchProviderId({
      config: params.config,
      search: params.search,
    }) ?? undefined,
  );
  if (isBuiltinSearchProviderId(configuredProviderId)) {
    return configuredProviderId;
  }

  if (
    params.runtimeWebSearch?.providerConfigured &&
    params.runtimeWebSearch.providerConfigured === configuredProviderId
  ) {
    return params.runtimeWebSearch.providerConfigured;
  }

  if (
    params.runtimeWebSearch?.selectedProvider &&
    params.runtimeWebSearch.providerSource !== "none"
  ) {
    return params.runtimeWebSearch.selectedProvider;
  }

  return resolveBuiltinSearchProvider(params.search);
}

function resolveRegisteredSearchProvider(params: {
  search?: WebSearchConfig;
  config?: OpenClawConfig;
  runtimeWebSearch?: RuntimeWebSearchMetadata;
}): SearchProviderPlugin {
  const configuredProviderId = normalizeSearchProviderId(
    resolveConfiguredSearchProviderId({
      config: params.config,
      search: params.search,
    }) ?? undefined,
  );
  const registeredProviders = new Map(
    getRegisteredSearchProviders(params.config).map((provider) => [
      normalizeSearchProviderId(provider.id),
      provider,
    ]),
  );

  if (configuredProviderId) {
    const registeredProvider = registeredProviders.get(configuredProviderId);
    if (registeredProvider) {
      return registeredProvider;
    }
    logVerbose(
      `web_search: configured provider "${configuredProviderId}" is not registered; failing closed`,
    );
    return createMissingSearchProviderPlugin(configuredProviderId);
  } else {
    for (const provider of registeredProviders.values()) {
      let isAvailable = false;
      try {
        isAvailable = provider.isAvailable?.(params.config) ?? false;
      } catch (error) {
        logVerbose(
          `web_search: plugin provider "${provider.id}" auto-detect failed during isAvailable: ${error instanceof Error ? error.message : String(error)}`,
        );
        continue;
      }
      if (isAvailable) {
        logVerbose(
          `web_search: no provider configured, auto-detected plugin provider "${provider.id}"`,
        );
        return provider;
      }
    }
  }
  const preferredBuiltinProvider = resolvePreferredBuiltinSearchProvider({
    config: params.config,
    search: params.search,
    runtimeWebSearch: params.runtimeWebSearch,
  });
  return (
    registeredProviders.get(preferredBuiltinProvider) ??
    registeredProviders.get(DEFAULT_PROVIDER) ??
    createMissingSearchProviderPlugin(preferredBuiltinProvider)
  );
}

function createSearchProviderSchema(params: {
  provider: SearchProviderPlugin;
  search?: WebSearchConfig;
  runtimeWebSearch?: RuntimeWebSearchMetadata;
}) {
  const providerId = resolveBuiltinSchemaProviderId(params.provider);
  if (providerId) {
    const perplexityTransport =
      params.runtimeWebSearch?.selectedProvider === "perplexity"
        ? params.runtimeWebSearch.perplexityTransport
        : resolvePerplexitySchemaTransportHint(resolvePerplexityConfig(params.search));
    return createWebSearchSchema({
      provider: providerId,
      perplexityTransport: providerId === "perplexity" ? perplexityTransport : undefined,
    });
  }
  return createExtensibleWebSearchSchema();
}

function parseSearchProviderRequest(
  args: Record<string, unknown>,
  search?: WebSearchConfig,
): SearchProviderRequest {
  const rawFreshness = readStringParam(args, "freshness");
  const rawDateAfter = readStringParam(args, "date_after");
  const rawDateBefore = readStringParam(args, "date_before");

  if (rawFreshness && (rawDateAfter || rawDateBefore)) {
    return {
      query: readStringParam(args, "query", { required: true }),
      count: resolveSearchCount(
        readNumberParam(args, "count", { integer: true }) ?? search?.maxResults ?? undefined,
        DEFAULT_SEARCH_COUNT,
      ),
      freshness: "__invalid_conflicting_time_filters__",
    };
  }

  return {
    query: readStringParam(args, "query", { required: true }),
    count: resolveSearchCount(
      readNumberParam(args, "count", { integer: true }) ?? search?.maxResults ?? undefined,
      DEFAULT_SEARCH_COUNT,
    ),
    country: readStringParam(args, "country"),
    language: readStringParam(args, "language"),
    search_lang: readStringParam(args, "search_lang"),
    ui_lang: readStringParam(args, "ui_lang"),
    freshness: rawFreshness,
    dateAfter: rawDateAfter ? normalizeToIsoDate(rawDateAfter) : undefined,
    dateBefore: rawDateBefore ? normalizeToIsoDate(rawDateBefore) : undefined,
    domainFilter: readStringArrayParam(args, "domain_filter") ?? undefined,
    maxTokens: readNumberParam(args, "max_tokens", { integer: true }) ?? undefined,
    maxTokensPerPage: readNumberParam(args, "max_tokens_per_page", { integer: true }) ?? undefined,
    providerConfig: search as Record<string, unknown> | undefined,
  };
}

function resolveSearchProviderPluginConfig(
  config: OpenClawConfig | undefined,
  provider: SearchProviderPlugin,
): Record<string, unknown> | undefined {
  if (!provider.pluginId) {
    return undefined;
  }
  const pluginConfig = config?.plugins?.entries?.[provider.pluginId]?.config;
  return pluginConfig && typeof pluginConfig === "object" ? pluginConfig : undefined;
}

function formatWebSearchExecutionLog(provider: SearchProviderPlugin): string {
  if (provider.pluginId) {
    return `web_search: executing plugin provider "${provider.id}" from "${provider.pluginId}"`;
  }
  return `web_search: executing built-in provider "${provider.id}"`;
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

  const provider = resolveRegisteredSearchProvider({
    search,
    config: options?.config,
    runtimeWebSearch: options?.runtimeWebSearch,
  });
  const parameters = createSearchProviderSchema({
    provider,
    search,
    runtimeWebSearch: options?.runtimeWebSearch,
  });
  const description =
    provider.description ??
    `Search the web using ${provider.name}. Returns relevant results for research.`;

  return {
    label: "Web Search",
    name: "web_search",
    description,
    parameters,
    execute: async (_toolCallId, args) => {
      const rawArgs = args as Record<string, unknown>;
      const rawFreshness = readStringParam(rawArgs, "freshness");
      const rawDateAfter = readStringParam(rawArgs, "date_after");
      const rawDateBefore = readStringParam(rawArgs, "date_before");
      if (rawFreshness && (rawDateAfter || rawDateBefore)) {
        return jsonResult({
          error: "conflicting_time_filters",
          message:
            "freshness and date_after/date_before cannot be used together. Use either freshness (day/week/month/year) or a date range (date_after/date_before), not both.",
          docs: "https://docs.openclaw.ai/tools/web",
        });
      }

      const request = parseSearchProviderRequest(rawArgs, search);
      if (rawDateAfter && !request.dateAfter) {
        return jsonResult({
          error: "invalid_date",
          message: "date_after must be YYYY-MM-DD format.",
          docs: "https://docs.openclaw.ai/tools/web",
        });
      }
      if (rawDateBefore && !request.dateBefore) {
        return jsonResult({
          error: "invalid_date",
          message: "date_before must be YYYY-MM-DD format.",
          docs: "https://docs.openclaw.ai/tools/web",
        });
      }
      if (request.dateAfter && request.dateBefore && request.dateAfter > request.dateBefore) {
        return jsonResult({
          error: "invalid_date_range",
          message: "date_after must be before date_before.",
          docs: "https://docs.openclaw.ai/tools/web",
        });
      }

      logVerbose(formatWebSearchExecutionLog(provider));
      const context = {
        config: options?.config ?? {},
        timeoutSeconds: resolveTimeoutSeconds(search?.timeoutSeconds, DEFAULT_TIMEOUT_SECONDS),
        cacheTtlMs: resolveCacheTtlMs(search?.cacheTtlMinutes, DEFAULT_CACHE_TTL_MINUTES),
        pluginConfig: resolveSearchProviderPluginConfig(options?.config, provider),
      };
      const result = await executePluginSearchProvider({
        provider,
        request,
        context,
      });
      return jsonResult(result);
    },
  };
}

export const __testing = {
  resolveSearchProvider: resolveBuiltinSearchProvider,
  resolveRegisteredSearchProvider,
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
} as const;
