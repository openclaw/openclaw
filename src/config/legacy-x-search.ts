import { mergeMissing } from "./legacy.shared.js";

type JsonRecord = Record<string, unknown>;

const XAI_PLUGIN_ID = "xai";
const X_SEARCH_LEGACY_PATH = "tools.web.x_search";
const X_SEARCH_PLUGIN_PATH = `plugins.entries.${XAI_PLUGIN_ID}.config.xSearch`;
const XAI_WEB_SEARCH_PLUGIN_KEY_PATH = `plugins.entries.${XAI_PLUGIN_ID}.config.webSearch.apiKey`;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneRecord<T extends JsonRecord | undefined>(value: T): T {
  if (!value) {
    return value;
  }
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

function resolveLegacyXSearchConfig(raw: unknown): JsonRecord | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }
  const tools = isRecord(raw.tools) ? raw.tools : undefined;
  const web = isRecord(tools?.web) ? tools.web : undefined;
  return isRecord(web?.x_search) ? web.x_search : undefined;
}

function splitLegacyXSearchPayload(legacy: JsonRecord): {
  auth: unknown;
  xSearch: JsonRecord | undefined;
} {
  const next: JsonRecord = {};
  for (const [key, value] of Object.entries(legacy)) {
    if (key === "apiKey") {
      continue;
    }
    next[key] = value;
  }
  return {
    auth: legacy.apiKey,
    xSearch: Object.keys(next).length > 0 ? next : undefined,
  };
}

export function listLegacyXSearchConfigPaths(raw: unknown): string[] {
  const legacy = resolveLegacyXSearchConfig(raw);
  if (!legacy) {
    return [];
  }
  return Object.keys(legacy).map((key) => `${X_SEARCH_LEGACY_PATH}.${key}`);
}

export function migrateLegacyXSearchConfig<T>(raw: T): { config: T; changes: string[] } {
  if (!isRecord(raw)) {
    return { config: raw, changes: [] };
  }
  const legacy = resolveLegacyXSearchConfig(raw);
  if (!legacy) {
    return { config: raw, changes: [] };
  }

  const nextRoot = structuredClone(raw);
  const tools = ensureRecord(nextRoot, "tools");
  const web = ensureRecord(tools, "web");
  delete web.x_search;

  const plugins = ensureRecord(nextRoot, "plugins");
  const entries = ensureRecord(plugins, "entries");
  const entry = ensureRecord(entries, XAI_PLUGIN_ID);
  const hadEnabled = entry.enabled !== undefined;
  if (!hadEnabled) {
    entry.enabled = true;
  }
  const config = ensureRecord(entry, "config");
  const { auth, xSearch } = splitLegacyXSearchPayload(legacy);
  const changes: string[] = [];

  if (auth !== undefined) {
    const existingWebSearch = isRecord(config.webSearch)
      ? cloneRecord(config.webSearch)
      : undefined;
    if (!existingWebSearch) {
      config.webSearch = { apiKey: auth };
      changes.push(`Moved ${X_SEARCH_LEGACY_PATH}.apiKey → ${XAI_WEB_SEARCH_PLUGIN_KEY_PATH}.`);
    } else if (!Object.prototype.hasOwnProperty.call(existingWebSearch, "apiKey")) {
      existingWebSearch.apiKey = auth;
      config.webSearch = existingWebSearch;
      changes.push(
        `Merged ${X_SEARCH_LEGACY_PATH}.apiKey → ${XAI_WEB_SEARCH_PLUGIN_KEY_PATH} (filled missing plugin auth).`,
      );
    } else {
      changes.push(
        `Removed ${X_SEARCH_LEGACY_PATH}.apiKey (${XAI_WEB_SEARCH_PLUGIN_KEY_PATH} already set).`,
      );
    }
  }

  if (xSearch) {
    const existingXSearch = isRecord(config.xSearch) ? cloneRecord(config.xSearch) : undefined;
    if (!existingXSearch) {
      config.xSearch = cloneRecord(xSearch);
      changes.push(`Moved ${X_SEARCH_LEGACY_PATH} → ${X_SEARCH_PLUGIN_PATH}.`);
    } else {
      const merged = cloneRecord(existingXSearch);
      mergeMissing(merged, xSearch);
      config.xSearch = merged;
      if (JSON.stringify(existingXSearch) !== JSON.stringify(merged) || !hadEnabled) {
        changes.push(
          `Merged ${X_SEARCH_LEGACY_PATH} → ${X_SEARCH_PLUGIN_PATH} (filled missing fields from legacy; kept explicit plugin config values).`,
        );
      } else {
        changes.push(`Removed ${X_SEARCH_LEGACY_PATH} (${X_SEARCH_PLUGIN_PATH} already set).`);
      }
    }
  } else if (!hadEnabled) {
    changes.push(`Removed empty ${X_SEARCH_LEGACY_PATH}.`);
  }

  return {
    config: nextRoot as T,
    changes,
  };
}
