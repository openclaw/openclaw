import type { OpenClawConfig } from "./config.js";
import { mergeMissing } from "./legacy.shared.js";

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

function hasOwnKey(target: JsonRecord, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(target, key);
}

function hasMappedLegacyWebSearchConfig(raw: unknown): boolean {
  const search = resolveLegacySearchConfig(raw);
  if (!search) {
    return false;
  }
  if (hasOwnKey(search, "apiKey")) {
    return true;
  }
  return (Object.keys(LEGACY_PROVIDER_MAP) as LegacyProviderId[]).some((providerId) =>
    isRecord(search[providerId]),
  );
}

function migratePluginWebSearchConfig(params: {
  root: JsonRecord;
  legacyPath: string;
  targetPath: string;
  pluginId: string;
  payload: JsonRecord;
  changes: string[];
}) {
  const plugins = ensureRecord(params.root, "plugins");
  const entries = ensureRecord(plugins, "entries");
  const entry = ensureRecord(entries, params.pluginId);
  const config = ensureRecord(entry, "config");
  const hadEnabled = entry.enabled !== undefined;
  const existing = isRecord(config.webSearch) ? cloneRecord(config.webSearch) : undefined;

  if (!hadEnabled) {
    entry.enabled = true;
  }

  if (!existing) {
    config.webSearch = cloneRecord(params.payload);
    params.changes.push(`Moved ${params.legacyPath} → ${params.targetPath}.`);
    return;
  }

  const merged = cloneRecord(existing);
  mergeMissing(merged, params.payload);
  const changed = JSON.stringify(merged) !== JSON.stringify(existing) || !hadEnabled;
  config.webSearch = merged;
  if (changed) {
    params.changes.push(
      `Merged ${params.legacyPath} → ${params.targetPath} (filled missing fields from legacy; kept explicit plugin config values).`,
    );
    return;
  }

  params.changes.push(`Removed ${params.legacyPath} (${params.targetPath} already set).`);
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

  return normalizeLegacyWebSearchConfigRecord(raw).config;
}

export function migrateLegacyWebSearchConfig<T>(raw: T): { config: T; changes: string[] } {
  if (!isRecord(raw)) {
    return { config: raw, changes: [] };
  }

  if (!hasMappedLegacyWebSearchConfig(raw)) {
    return { config: raw, changes: [] };
  }

  return normalizeLegacyWebSearchConfigRecord(raw);
}

function normalizeLegacyWebSearchConfigRecord<T extends JsonRecord>(
  raw: T,
): {
  config: T;
  changes: string[];
} {
  const nextRoot = cloneRecord(raw);
  const tools = ensureRecord(nextRoot, "tools");
  const web = ensureRecord(tools, "web");
  const search = resolveLegacySearchConfig(nextRoot);
  if (!search) {
    return { config: raw, changes: [] };
  }
  const nextSearch: JsonRecord = {};
  const changes: string[] = [];

  for (const [key, value] of Object.entries(search)) {
    if (key === "apiKey") {
      continue;
    }
    if (
      (Object.keys(LEGACY_PROVIDER_MAP) as LegacyProviderId[]).includes(key as LegacyProviderId)
    ) {
      if (isRecord(value)) {
        continue;
      }
    }
    if (GENERIC_WEB_SEARCH_KEYS.has(key) || !isRecord(value)) {
      nextSearch[key] = value;
    }
  }
  web.search = nextSearch;

  const legacyBraveConfig = copyLegacyProviderConfig(search, "brave");
  const braveConfig = legacyBraveConfig ?? {};
  if (hasOwnKey(search, "apiKey")) {
    braveConfig.apiKey = search.apiKey;
  }
  if (Object.keys(braveConfig).length > 0) {
    migratePluginWebSearchConfig({
      root: nextRoot,
      legacyPath: hasOwnKey(search, "apiKey")
        ? "tools.web.search.apiKey"
        : "tools.web.search.brave",
      targetPath:
        hasOwnKey(search, "apiKey") && !legacyBraveConfig
          ? "plugins.entries.brave.config.webSearch.apiKey"
          : "plugins.entries.brave.config.webSearch",
      pluginId: LEGACY_PROVIDER_MAP.brave,
      payload: braveConfig,
      changes,
    });
  }

  for (const providerId of ["firecrawl", "gemini", "grok", "kimi", "perplexity"] as const) {
    const scoped = copyLegacyProviderConfig(search, providerId);
    if (!scoped || Object.keys(scoped).length === 0) {
      continue;
    }
    migratePluginWebSearchConfig({
      root: nextRoot,
      legacyPath: `tools.web.search.${providerId}`,
      targetPath: `plugins.entries.${LEGACY_PROVIDER_MAP[providerId]}.config.webSearch`,
      pluginId: LEGACY_PROVIDER_MAP[providerId],
      payload: scoped,
      changes,
    });
  }

  return { config: nextRoot, changes };
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
