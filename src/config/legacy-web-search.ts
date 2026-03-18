import type { OpenClawConfig } from "./config.js";

type JsonRecord = Record<string, unknown>;

const GENERIC_WEB_SEARCH_KEYS = new Set([
  "enabled",
  "provider",
  "maxResults",
  "timeoutSeconds",
  "cacheTtlMinutes",
]);

const LEGACY_PROVIDER_MAP = {
  brave: "brave",
  firecrawl: "firecrawl",
  gemini: "google",
  grok: "xai",
  kimi: "moonshot",
  perplexity: "perplexity",
} as const;

type LegacyProviderId = keyof typeof LEGACY_PROVIDER_MAP;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneRecord<T extends JsonRecord>(value: T | undefined): T {
  return { ...value } as T;
}

function ensureRecord(target: JsonRecord, key: string): JsonRecord {
  const current = target[key];
  if (isRecord(current)) {
    return current;
  }
  const next: JsonRecord = {};
  target[key] = next;
  return next;
}

function resolveLegacySearchConfig(raw: unknown): JsonRecord | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }
  const tools = isRecord(raw.tools) ? raw.tools : undefined;
  const web = isRecord(tools?.web) ? tools.web : undefined;
  return isRecord(web?.search) ? web.search : undefined;
}

function copyLegacyProviderConfig(
  search: JsonRecord,
  providerKey: LegacyProviderId,
): JsonRecord | undefined {
  const current = search[providerKey];
  return isRecord(current) ? cloneRecord(current) : undefined;
}

function setPluginWebSearchConfig(
  target: JsonRecord,
  pluginId: string,
  webSearchConfig: JsonRecord,
): void {
  const plugins = ensureRecord(target, "plugins");
  const entries = ensureRecord(plugins, "entries");
  const entry = ensureRecord(entries, pluginId);
  if (entry.enabled === undefined) {
    entry.enabled = true;
  }
  const config = ensureRecord(entry, "config");
  config.webSearch = webSearchConfig;
}

export function listLegacyWebSearchConfigPaths(raw: unknown): string[] {
  const search = resolveLegacySearchConfig(raw);
  if (!search) {
    return [];
  }
  const paths: string[] = [];

  if ("apiKey" in search) {
    paths.push("tools.web.search.apiKey");
  }
  for (const providerId of Object.keys(LEGACY_PROVIDER_MAP) as LegacyProviderId[]) {
    const scoped = search[providerId];
    if (isRecord(scoped)) {
      for (const key of Object.keys(scoped)) {
        paths.push(`tools.web.search.${providerId}.${key}`);
      }
    }
  }
  return paths;
}

export function normalizeLegacyWebSearchConfig<T>(raw: T): T {
  if (!isRecord(raw)) {
    return raw;
  }

  const search = resolveLegacySearchConfig(raw);
  if (!search) {
    return raw;
  }

  const nextRoot = cloneRecord(raw);
  const tools = ensureRecord(nextRoot, "tools");
  const web = ensureRecord(tools, "web");
  const nextSearch: JsonRecord = {};

  for (const [key, value] of Object.entries(search)) {
    if (GENERIC_WEB_SEARCH_KEYS.has(key)) {
      nextSearch[key] = value;
    }
  }
  web.search = nextSearch;

  const braveConfig = copyLegacyProviderConfig(search, "brave") ?? {};
  if ("apiKey" in search) {
    braveConfig.apiKey = search.apiKey;
  }
  if (Object.keys(braveConfig).length > 0) {
    setPluginWebSearchConfig(nextRoot, LEGACY_PROVIDER_MAP.brave, braveConfig);
  }

  for (const providerId of ["firecrawl", "gemini", "grok", "kimi", "perplexity"] as const) {
    const scoped = copyLegacyProviderConfig(search, providerId);
    if (!scoped || Object.keys(scoped).length === 0) {
      continue;
    }
    setPluginWebSearchConfig(nextRoot, LEGACY_PROVIDER_MAP[providerId], scoped);
  }

  return nextRoot as T;
}

export function resolvePluginWebSearchConfig(
  config: OpenClawConfig | undefined,
  pluginId: string,
): Record<string, unknown> | undefined {
  const pluginConfig = config?.plugins?.entries?.[pluginId]?.config;
  if (!isRecord(pluginConfig)) {
    return undefined;
  }
  const webSearch = pluginConfig.webSearch;
  return isRecord(webSearch) ? webSearch : undefined;
}
