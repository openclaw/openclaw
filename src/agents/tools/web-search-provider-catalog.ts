export const BUILTIN_WEB_SEARCH_PROVIDER_IDS = [
  "brave",
  "gemini",
  "grok",
  "kimi",
  "perplexity",
] as const;

export type BuiltinWebSearchProviderId = (typeof BUILTIN_WEB_SEARCH_PROVIDER_IDS)[number];

export const MIGRATED_BUNDLED_WEB_SEARCH_PROVIDER_IDS = BUILTIN_WEB_SEARCH_PROVIDER_IDS;

export type MigratedBundledWebSearchProviderId =
  (typeof MIGRATED_BUNDLED_WEB_SEARCH_PROVIDER_IDS)[number];

export const bundledCoreWebSearchPluginId = (providerId: BuiltinWebSearchProviderId): string =>
  `search-${providerId}`;

export const MIGRATED_BUNDLED_WEB_SEARCH_PLUGIN_IDS = MIGRATED_BUNDLED_WEB_SEARCH_PROVIDER_IDS.map(
  bundledCoreWebSearchPluginId,
);

export type BuiltinWebSearchProviderEntry = {
  value: BuiltinWebSearchProviderId;
  label: string;
  hint: string;
  envKeys: readonly string[];
  placeholder: string;
  signupUrl: string;
  apiKeyConfigPath: string;
};

const BUILTIN_WEB_SEARCH_PROVIDER_CATALOG: Record<
  BuiltinWebSearchProviderId,
  Omit<BuiltinWebSearchProviderEntry, "value">
> = {
  brave: {
    label: "Brave Search",
    hint: "Structured results · country/language/time filters",
    envKeys: ["BRAVE_API_KEY"],
    placeholder: "BSA...",
    signupUrl: "https://brave.com/search/api/",
    apiKeyConfigPath: "tools.web.search.apiKey",
  },
  gemini: {
    label: "Gemini (Google Search)",
    hint: "Google Search grounding · AI-synthesized",
    envKeys: ["GEMINI_API_KEY"],
    placeholder: "AIza...",
    signupUrl: "https://aistudio.google.com/apikey",
    apiKeyConfigPath: "tools.web.search.gemini.apiKey",
  },
  grok: {
    label: "Grok (xAI)",
    hint: "xAI web-grounded responses",
    envKeys: ["XAI_API_KEY"],
    placeholder: "xai-...",
    signupUrl: "https://console.x.ai/",
    apiKeyConfigPath: "tools.web.search.grok.apiKey",
  },
  kimi: {
    label: "Kimi (Moonshot)",
    hint: "Moonshot web search",
    envKeys: ["KIMI_API_KEY", "MOONSHOT_API_KEY"],
    placeholder: "sk-...",
    signupUrl: "https://platform.moonshot.cn/",
    apiKeyConfigPath: "tools.web.search.kimi.apiKey",
  },
  perplexity: {
    label: "Perplexity Search",
    hint: "Structured results · domain/country/language/time filters",
    envKeys: ["PERPLEXITY_API_KEY"],
    placeholder: "pplx-...",
    signupUrl: "https://www.perplexity.ai/settings/api",
    apiKeyConfigPath: "tools.web.search.perplexity.apiKey",
  },
};

export const BUILTIN_WEB_SEARCH_PROVIDER_OPTIONS: readonly BuiltinWebSearchProviderEntry[] =
  BUILTIN_WEB_SEARCH_PROVIDER_IDS.map((value) => ({
    value,
    ...BUILTIN_WEB_SEARCH_PROVIDER_CATALOG[value],
  }));

export function isBuiltinWebSearchProviderId(value: string): value is BuiltinWebSearchProviderId {
  return BUILTIN_WEB_SEARCH_PROVIDER_IDS.includes(value as BuiltinWebSearchProviderId);
}

export function normalizeBuiltinWebSearchProvider(
  value: unknown,
): BuiltinWebSearchProviderId | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  return isBuiltinWebSearchProviderId(normalized) ? normalized : undefined;
}

export function getBuiltinWebSearchProviderEntry(
  provider: BuiltinWebSearchProviderId,
): BuiltinWebSearchProviderEntry {
  return BUILTIN_WEB_SEARCH_PROVIDER_OPTIONS.find((entry) => entry.value === provider)!;
}

function getScopedSearchConfig(
  search: Record<string, unknown>,
  provider: BuiltinWebSearchProviderId,
): Record<string, unknown> | undefined {
  if (provider === "brave") {
    return search;
  }
  const scoped = search[provider];
  return typeof scoped === "object" && scoped !== null && !Array.isArray(scoped)
    ? (scoped as Record<string, unknown>)
    : undefined;
}

export function readBuiltinWebSearchApiKeyValue(
  search: Record<string, unknown> | undefined,
  provider: BuiltinWebSearchProviderId,
): unknown {
  if (!search) {
    return undefined;
  }
  return getScopedSearchConfig(search, provider)?.apiKey;
}

export function writeBuiltinWebSearchApiKeyValue(params: {
  search: Record<string, unknown>;
  provider: BuiltinWebSearchProviderId;
  value: unknown;
}): void {
  if (params.provider === "brave") {
    params.search.apiKey = params.value;
    return;
  }
  const current = getScopedSearchConfig(params.search, params.provider);
  if (current) {
    current.apiKey = params.value;
    return;
  }
  params.search[params.provider] = { apiKey: params.value };
}
