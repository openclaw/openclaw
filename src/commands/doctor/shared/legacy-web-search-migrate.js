import { mergeMissing } from "../../../config/legacy.shared.js";
import { loadPluginManifestRegistry, resolveManifestContractOwnerPluginId, } from "../../../plugins/manifest-registry.js";
import { cloneRecord, ensureRecord, hasOwnKey, isRecord, } from "./legacy-config-record-shared.js";
const MODERN_SCOPED_WEB_SEARCH_KEYS = new Set(["openaiCodex"]);
// Tavily only ever used the plugin-owned config path, so there is no legacy
// `tools.web.search.tavily.*` shape to migrate.
const NON_MIGRATED_LEGACY_WEB_SEARCH_PROVIDER_IDS = new Set(["tavily"]);
const LEGACY_GLOBAL_WEB_SEARCH_PROVIDER_ID = "brave";
let legacyWebSearchProviderIdsCache;
let legacyWebSearchProviderIdSetCache;
function getLegacyWebSearchProviderIds() {
    legacyWebSearchProviderIdsCache ??= loadPluginManifestRegistry({ cache: true })
        .plugins.filter((plugin) => plugin.origin === "bundled")
        .flatMap((plugin) => plugin.contracts?.webSearchProviders ?? [])
        .filter((providerId) => !NON_MIGRATED_LEGACY_WEB_SEARCH_PROVIDER_IDS.has(providerId))
        .toSorted((left, right) => left.localeCompare(right));
    return legacyWebSearchProviderIdsCache;
}
function getLegacyWebSearchProviderIdSet() {
    legacyWebSearchProviderIdSetCache ??= new Set(getLegacyWebSearchProviderIds());
    return legacyWebSearchProviderIdSetCache;
}
function resolveLegacySearchConfig(raw) {
    if (!isRecord(raw)) {
        return undefined;
    }
    const tools = isRecord(raw.tools) ? raw.tools : undefined;
    const web = isRecord(tools?.web) ? tools.web : undefined;
    return isRecord(web?.search) ? web.search : undefined;
}
function copyLegacyProviderConfig(search, providerKey) {
    const current = search[providerKey];
    return isRecord(current) ? cloneRecord(current) : undefined;
}
function hasMappedLegacyWebSearchConfig(raw) {
    const search = resolveLegacySearchConfig(raw);
    if (!search) {
        return false;
    }
    if (hasOwnKey(search, "apiKey")) {
        return true;
    }
    return getLegacyWebSearchProviderIds().some((providerId) => isRecord(search[providerId]));
}
function resolveLegacyGlobalWebSearchMigration(search) {
    const legacyProviderConfig = copyLegacyProviderConfig(search, LEGACY_GLOBAL_WEB_SEARCH_PROVIDER_ID);
    const payload = legacyProviderConfig ?? {};
    const hasLegacyApiKey = hasOwnKey(search, "apiKey");
    if (hasLegacyApiKey) {
        payload.apiKey = search.apiKey;
    }
    if (Object.keys(payload).length === 0) {
        return null;
    }
    const pluginId = resolveManifestContractOwnerPluginId({
        contract: "webSearchProviders",
        value: LEGACY_GLOBAL_WEB_SEARCH_PROVIDER_ID,
        origin: "bundled",
    }) ?? LEGACY_GLOBAL_WEB_SEARCH_PROVIDER_ID;
    return {
        pluginId,
        payload,
        legacyPath: hasLegacyApiKey
            ? "tools.web.search.apiKey"
            : `tools.web.search.${LEGACY_GLOBAL_WEB_SEARCH_PROVIDER_ID}`,
        targetPath: hasLegacyApiKey && !legacyProviderConfig
            ? `plugins.entries.${pluginId}.config.webSearch.apiKey`
            : `plugins.entries.${pluginId}.config.webSearch`,
    };
}
function migratePluginWebSearchConfig(params) {
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
        params.changes.push(`Merged ${params.legacyPath} → ${params.targetPath} (filled missing fields from legacy; kept explicit plugin config values).`);
        return;
    }
    params.changes.push(`Removed ${params.legacyPath} (${params.targetPath} already set).`);
}
export function listLegacyWebSearchConfigPaths(raw) {
    const search = resolveLegacySearchConfig(raw);
    if (!search) {
        return [];
    }
    const paths = [];
    if ("apiKey" in search) {
        paths.push("tools.web.search.apiKey");
    }
    for (const providerId of getLegacyWebSearchProviderIds()) {
        const scoped = search[providerId];
        if (isRecord(scoped)) {
            for (const key of Object.keys(scoped)) {
                paths.push(`tools.web.search.${providerId}.${key}`);
            }
        }
    }
    return paths;
}
export function normalizeLegacyWebSearchConfig(raw) {
    if (!isRecord(raw)) {
        return raw;
    }
    const search = resolveLegacySearchConfig(raw);
    if (!search) {
        return raw;
    }
    return normalizeLegacyWebSearchConfigRecord(raw).config;
}
export function migrateLegacyWebSearchConfig(raw) {
    if (!isRecord(raw)) {
        return { config: raw, changes: [] };
    }
    if (!hasMappedLegacyWebSearchConfig(raw)) {
        return { config: raw, changes: [] };
    }
    return normalizeLegacyWebSearchConfigRecord(raw);
}
function normalizeLegacyWebSearchConfigRecord(raw) {
    const nextRoot = cloneRecord(raw);
    const tools = ensureRecord(nextRoot, "tools");
    const web = ensureRecord(tools, "web");
    const search = resolveLegacySearchConfig(nextRoot);
    if (!search) {
        return { config: raw, changes: [] };
    }
    const nextSearch = {};
    const changes = [];
    for (const [key, value] of Object.entries(search)) {
        if (key === "apiKey") {
            continue;
        }
        if (getLegacyWebSearchProviderIdSet().has(key) && isRecord(value)) {
            continue;
        }
        if (MODERN_SCOPED_WEB_SEARCH_KEYS.has(key) || !isRecord(value)) {
            nextSearch[key] = value;
        }
    }
    web.search = nextSearch;
    const globalSearchMigration = resolveLegacyGlobalWebSearchMigration(search);
    if (globalSearchMigration) {
        migratePluginWebSearchConfig({
            root: nextRoot,
            legacyPath: globalSearchMigration.legacyPath,
            targetPath: globalSearchMigration.targetPath,
            pluginId: globalSearchMigration.pluginId,
            payload: globalSearchMigration.payload,
            changes,
        });
    }
    for (const providerId of getLegacyWebSearchProviderIds()) {
        if (providerId === LEGACY_GLOBAL_WEB_SEARCH_PROVIDER_ID) {
            continue;
        }
        const scoped = copyLegacyProviderConfig(search, providerId);
        if (!scoped || Object.keys(scoped).length === 0) {
            continue;
        }
        const pluginId = resolveManifestContractOwnerPluginId({
            contract: "webSearchProviders",
            value: providerId,
            origin: "bundled",
        });
        if (!pluginId) {
            continue;
        }
        migratePluginWebSearchConfig({
            root: nextRoot,
            legacyPath: `tools.web.search.${providerId}`,
            targetPath: `plugins.entries.${pluginId}.config.webSearch`,
            pluginId,
            payload: scoped,
            changes,
        });
    }
    return { config: nextRoot, changes };
}
export function resolvePluginWebSearchConfig(config, pluginId) {
    const pluginConfig = config?.plugins?.entries?.[pluginId]?.config;
    if (!isRecord(pluginConfig)) {
        return undefined;
    }
    const webSearch = pluginConfig.webSearch;
    return isRecord(webSearch) ? webSearch : undefined;
}
