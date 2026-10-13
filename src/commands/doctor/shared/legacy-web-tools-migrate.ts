// Legacy web tool config migrations into plugin-owned provider config.
import { ensureRecord } from "../../../config/legacy.shared.js";
import { mergeMissing } from "../../../config/merge-missing.js";
import { isBlockedObjectKey } from "../../../infra/prototype-keys.js";
import { isRecord, type JsonRecord } from "./legacy-config-record-shared.js";

const LEGACY_WEB_SEARCH_OWNERS = new Map<string, string>([
  ["brave", "brave"],
  ["duckduckgo", "duckduckgo"],
  ["exa", "exa"],
  ["firecrawl", "firecrawl"],
  ["gemini", "google"],
  ["grok", "xai"],
  ["kimi", "moonshot"],
  ["minimax", "minimax"],
  ["ollama", "ollama"],
  ["perplexity", "perplexity"],
  ["searxng", "searxng"],
]);
const LEGACY_WEB_SEARCH_PROVIDER_IDS = [...LEGACY_WEB_SEARCH_OWNERS.keys()].toSorted(
  (left, right) => left.localeCompare(right),
);
const RETIRED_GROK_SEARCH_MODELS = new Set([
  "grok-4-1-fast",
  "grok-4-1-fast-reasoning",
  "grok-4-fast",
  "grok-4-fast-reasoning",
  "grok-4-0709",
]);
const RETIRED_GROK_CODE_MODELS = new Set([
  "grok-code-fast-1",
  "grok-code-fast",
  "grok-code-fast-1-0825",
]);
const RETIRED_X_SEARCH_MODELS = new Set([
  "grok-4-1-fast-non-reasoning",
  "grok-4-fast-non-reasoning",
  "grok-3",
]);

type PluginMove = {
  pluginId: string;
  configKey: "webSearch" | "webFetch";
  payload: JsonRecord;
  legacyPath: string;
  targetPath: string;
  mergeMode?: "missing" | "own-api-key";
};

function resolveWebSlot(raw: unknown, slot: string): JsonRecord | undefined {
  if (!isRecord(raw) || !isRecord(raw.tools) || !isRecord(raw.tools.web)) {
    return undefined;
  }
  const value = raw.tools.web[slot];
  return isRecord(value) ? value : undefined;
}

function retainedSource(source: JsonRecord, removedRecordKeys: ReadonlySet<string>): JsonRecord {
  const retained: JsonRecord = {};
  for (const [key, value] of Object.entries(source)) {
    if (isBlockedObjectKey(key) || (removedRecordKeys.has(key) && isRecord(value))) {
      continue;
    }
    retained[key] = value;
  }
  return retained;
}

function applyPluginMove(root: JsonRecord, move: PluginMove, changes: string[]): boolean {
  const entries = ensureRecord(ensureRecord(root, "plugins"), "entries");
  const entry = ensureRecord(entries, move.pluginId);
  const activated = entry.enabled === undefined;
  if (activated) {
    entry.enabled = true;
  }
  const config = ensureRecord(entry, "config");
  const existingValue = config[move.configKey];
  const existingWasRecord = isRecord(existingValue);
  const existing = { ...(existingWasRecord ? existingValue : undefined) };

  if (!existingWasRecord) {
    config[move.configKey] = { ...move.payload };
    changes.push(`Moved ${move.legacyPath} → ${move.targetPath}.`);
  } else if (move.mergeMode === "own-api-key") {
    if (!Object.hasOwn(existing, "apiKey")) {
      existing.apiKey = move.payload.apiKey;
      config[move.configKey] = existing;
      changes.push(`Merged ${move.legacyPath} → ${move.targetPath} (filled missing plugin auth).`);
    } else {
      changes.push(`Removed ${move.legacyPath} (${move.targetPath} already set).`);
    }
  } else {
    const merged = { ...existing };
    mergeMissing(merged, move.payload);
    config[move.configKey] = merged;
    if (JSON.stringify(merged) !== JSON.stringify(existing) || activated) {
      changes.push(
        `Merged ${move.legacyPath} → ${move.targetPath} (filled missing fields from legacy; kept explicit plugin config values).`,
      );
    } else {
      changes.push(`Removed ${move.legacyPath} (${move.targetPath} already set).`);
    }
  }
  return activated;
}

function resolveGrokModelTarget(model: unknown, xSearch: boolean): string | undefined {
  if (typeof model !== "string") {
    return undefined;
  }
  const normalized = model.trim().toLowerCase();
  if ((xSearch ? RETIRED_X_SEARCH_MODELS : RETIRED_GROK_SEARCH_MODELS).has(normalized)) {
    return "grok-4.3";
  }
  return RETIRED_GROK_CODE_MODELS.has(normalized) ? "grok-build-0.1" : undefined;
}

function searchMove(
  providerId: string,
  payload: JsonRecord,
  paths?: { legacyPath: string; targetPath: string },
): PluginMove {
  const pluginId = LEGACY_WEB_SEARCH_OWNERS.get(providerId) ?? providerId;
  return {
    pluginId,
    configKey: "webSearch",
    payload,
    legacyPath: paths?.legacyPath ?? `tools.web.search.${providerId}`,
    targetPath: paths?.targetPath ?? `plugins.entries.${pluginId}.config.webSearch`,
  };
}

export function migrateLegacyWebSearchConfig<T>(raw: T): { config: T; changes: string[] } {
  const source = resolveWebSlot(raw, "search");
  const providerIds = LEGACY_WEB_SEARCH_PROVIDER_IDS;
  if (
    !source ||
    (!Object.hasOwn(source, "apiKey") && !providerIds.some((id) => isRecord(source[id])))
  ) {
    return { config: raw, changes: [] };
  }
  // SAFETY: resolveWebSlot admitted a record root; cloning preserves its input shape.
  const next = structuredClone(raw) as T & JsonRecord;
  const retained = retainedSource(source, new Set(["apiKey", ...providerIds]));
  delete retained.apiKey;
  ensureRecord(ensureRecord(next, "tools"), "web").search = retained;
  const changes: string[] = [];
  const braveRecord = isRecord(source.brave) ? source.brave : undefined;
  const bravePayload = { ...braveRecord };
  if (Object.hasOwn(source, "apiKey")) {
    bravePayload.apiKey = source.apiKey;
  }
  if (Object.keys(bravePayload).length > 0) {
    const hasGlobalApiKey = Object.hasOwn(source, "apiKey");
    applyPluginMove(
      next,
      searchMove(
        "brave",
        bravePayload,
        hasGlobalApiKey
          ? {
              legacyPath: "tools.web.search.apiKey",
              targetPath: braveRecord
                ? "plugins.entries.brave.config.webSearch"
                : "plugins.entries.brave.config.webSearch.apiKey",
            }
          : undefined,
      ),
      changes,
    );
  }
  for (const providerId of providerIds) {
    if (providerId === "brave" || !isRecord(source[providerId])) {
      continue;
    }
    const payload = { ...source[providerId] };
    if (Object.keys(payload).length === 0) {
      continue;
    }
    if (providerId === "grok") {
      const modelTarget = resolveGrokModelTarget(payload.model, false);
      if (modelTarget) {
        changes.push(
          `Updated tools.web.search.grok.model from ${JSON.stringify(payload.model)} to ${JSON.stringify(modelTarget)}.`,
        );
        payload.model = modelTarget;
      }
    }
    applyPluginMove(next, searchMove(providerId, payload), changes);
  }
  return { config: next, changes };
}

export function migrateLegacyWebFetchConfig<T>(raw: T): { config: T; changes: string[] } {
  const source = resolveWebSlot(raw, "fetch");
  if (!source || !isRecord(source.firecrawl)) {
    return { config: raw, changes: [] };
  }
  // SAFETY: resolveWebSlot admitted a record root; cloning preserves its input shape.
  const next = structuredClone(raw) as T & JsonRecord;
  const payload = { ...source.firecrawl };
  delete payload.enabled;
  ensureRecord(ensureRecord(next, "tools"), "web").fetch = retainedSource(
    source,
    new Set(["firecrawl"]),
  );
  const changes: string[] = [];
  if (Object.keys(payload).length > 0) {
    applyPluginMove(
      next,
      {
        pluginId: "firecrawl",
        configKey: "webFetch",
        payload,
        legacyPath: "tools.web.fetch.firecrawl",
        targetPath: "plugins.entries.firecrawl.config.webFetch",
      },
      changes,
    );
  } else {
    changes.push("Removed empty tools.web.fetch.firecrawl.");
  }
  return { config: next, changes };
}

/** Resolve a supported replacement for a retired legacy X search model. */
export function resolveLegacyXSearchModelTarget(model: unknown): string | undefined {
  return resolveGrokModelTarget(model, true);
}

export function migrateLegacyXSearchConfig<T>(raw: T): { config: T; changes: string[] } {
  const source = resolveWebSlot(raw, "x_search");
  if (!source) {
    return { config: raw, changes: [] };
  }
  const hasAuth = Object.hasOwn(source, "apiKey");
  const modelTarget = resolveLegacyXSearchModelTarget(source.model);
  if (!hasAuth && !modelTarget) {
    return { config: raw, changes: [] };
  }
  // SAFETY: resolveWebSlot admitted a record root; cloning preserves its input shape.
  const next = structuredClone(raw) as T & JsonRecord;
  const web = ensureRecord(ensureRecord(next, "tools"), "web");
  const retained = { ...source };
  const changes: string[] = [];
  if (hasAuth) {
    delete retained.apiKey;
  }
  if (modelTarget) {
    changes.push(
      `Updated tools.web.x_search.model from ${JSON.stringify(source.model)} to ${JSON.stringify(modelTarget)}.`,
    );
    retained.model = modelTarget;
  }
  const empty = Object.keys(retained).length === 0;
  if (empty) {
    delete web.x_search;
  } else {
    web.x_search = retained;
  }
  if (hasAuth) {
    const activated = applyPluginMove(
      next,
      {
        pluginId: "xai",
        configKey: "webSearch",
        payload: { apiKey: source.apiKey },
        legacyPath: "tools.web.x_search.apiKey",
        targetPath: "plugins.entries.xai.config.webSearch.apiKey",
        mergeMode: "own-api-key",
      },
      changes,
    );
    if (activated && empty) {
      changes.push("Removed empty tools.web.x_search.");
    }
  }
  return { config: next, changes };
}

/** List legacy tools.web.search provider config paths present in raw config. */
export function listLegacyWebSearchConfigPaths(raw: unknown): string[] {
  const source = resolveWebSlot(raw, "search");
  if (!source) {
    return [];
  }
  const paths = Object.hasOwn(source, "apiKey") ? ["tools.web.search.apiKey"] : [];
  for (const providerId of LEGACY_WEB_SEARCH_PROVIDER_IDS) {
    if (isRecord(source[providerId])) {
      paths.push(
        ...Object.keys(source[providerId]).map((key) => `tools.web.search.${providerId}.${key}`),
      );
    }
  }
  return paths;
}
