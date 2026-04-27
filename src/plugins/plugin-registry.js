import { normalizeProviderId } from "../agents/provider-id.js";
import { normalizePluginsConfigWithResolver, } from "./config-normalization-shared.js";
import { readPersistedInstalledPluginIndexSync, } from "./installed-plugin-index-store.js";
import { getInstalledPluginRecord, isInstalledPluginEnabled, listInstalledPluginContributionIds, listInstalledPluginRecords, loadInstalledPluginIndex, resolveInstalledPluginContributionOwners, resolveInstalledPluginIndexPolicyHash, } from "./installed-plugin-index.js";
export const DISABLE_PERSISTED_PLUGIN_REGISTRY_ENV = "OPENCLAW_DISABLE_PERSISTED_PLUGIN_REGISTRY";
function formatDeprecatedPersistedRegistryDisableWarning() {
    return `${DISABLE_PERSISTED_PLUGIN_REGISTRY_ENV} is a deprecated break-glass compatibility switch; use \`openclaw plugins registry --refresh\` or \`openclaw doctor --fix\` to repair registry state.`;
}
function normalizeContributionId(value) {
    return value.trim();
}
function normalizePluginRegistryAlias(value) {
    return value.trim();
}
function normalizePluginRegistryAliasKey(value) {
    return normalizePluginRegistryAlias(value).toLowerCase();
}
export function createPluginRegistryIdNormalizer(index) {
    const aliases = new Map();
    for (const plugin of [...index.plugins].toSorted((left, right) => left.pluginId.localeCompare(right.pluginId))) {
        const pluginId = normalizePluginRegistryAlias(plugin.pluginId);
        if (!pluginId) {
            continue;
        }
        aliases.set(normalizePluginRegistryAliasKey(pluginId), pluginId);
        for (const alias of [
            ...plugin.contributions.providers,
            ...plugin.contributions.channels,
            ...plugin.contributions.setupProviders,
            ...plugin.contributions.cliBackends,
            ...plugin.contributions.modelCatalogProviders,
        ]) {
            const normalizedAlias = normalizePluginRegistryAlias(alias);
            const normalizedAliasKey = normalizePluginRegistryAliasKey(alias);
            if (normalizedAlias && !aliases.has(normalizedAliasKey)) {
                aliases.set(normalizedAliasKey, pluginId);
            }
        }
    }
    return (pluginId) => {
        const trimmed = normalizePluginRegistryAlias(pluginId);
        return aliases.get(normalizePluginRegistryAliasKey(trimmed)) ?? trimmed;
    };
}
export function normalizePluginsConfigWithRegistry(config, index) {
    return normalizePluginsConfigWithResolver(config, createPluginRegistryIdNormalizer(index));
}
function hasEnvFlag(env, name) {
    const value = env[name]?.trim().toLowerCase();
    return Boolean(value && value !== "0" && value !== "false" && value !== "no");
}
export function loadPluginRegistrySnapshotWithMetadata(params = {}) {
    if (params.index) {
        return {
            snapshot: params.index,
            source: "provided",
            diagnostics: [],
        };
    }
    const env = params.env ?? process.env;
    const diagnostics = [];
    const disabledByCaller = params.preferPersisted === false;
    const disabledByEnv = hasEnvFlag(env, DISABLE_PERSISTED_PLUGIN_REGISTRY_ENV);
    const persistedReadsEnabled = !disabledByCaller && !disabledByEnv;
    if (persistedReadsEnabled) {
        const persisted = readPersistedInstalledPluginIndexSync(params);
        if (persisted) {
            if (params.config &&
                persisted.policyHash !== resolveInstalledPluginIndexPolicyHash(params.config)) {
                diagnostics.push({
                    level: "warn",
                    code: "persisted-registry-stale-policy",
                    message: "Persisted plugin registry policy does not match current config; using derived plugin index. Run `openclaw plugins registry --refresh` to update the persisted registry.",
                });
            }
            else {
                return {
                    snapshot: persisted,
                    source: "persisted",
                    diagnostics,
                };
            }
        }
        else {
            diagnostics.push({
                level: "info",
                code: "persisted-registry-missing",
                message: "Persisted plugin registry is missing or invalid; using derived plugin index.",
            });
        }
    }
    else {
        diagnostics.push({
            level: "warn",
            code: "persisted-registry-disabled",
            message: disabledByEnv
                ? `${formatDeprecatedPersistedRegistryDisableWarning()} Using legacy derived plugin index.`
                : "Persisted plugin registry reads are disabled by the caller; using derived plugin index.",
        });
    }
    return {
        snapshot: loadInstalledPluginIndex(params),
        source: "derived",
        diagnostics,
    };
}
function resolveSnapshot(params = {}) {
    return loadPluginRegistrySnapshotWithMetadata(params).snapshot;
}
export function loadPluginRegistrySnapshot(params = {}) {
    return resolveSnapshot(params);
}
export function listPluginRecords(params = {}) {
    return listInstalledPluginRecords(resolveSnapshot(params));
}
export function getPluginRecord(params) {
    return getInstalledPluginRecord(resolveSnapshot(params), params.pluginId);
}
export function isPluginEnabled(params) {
    return isInstalledPluginEnabled(resolveSnapshot(params), params.pluginId, params.config);
}
export function listPluginContributionIds(params) {
    return listInstalledPluginContributionIds(resolveSnapshot(params), params.contribution, {
        includeDisabled: params.includeDisabled,
        config: params.config,
    });
}
export function resolvePluginContributionOwners(params) {
    return resolveInstalledPluginContributionOwners(resolveSnapshot(params), params.contribution, params.matches, {
        includeDisabled: params.includeDisabled,
        config: params.config,
    });
}
export function resolveProviderOwners(params) {
    const providerId = normalizeProviderId(params.providerId);
    if (!providerId) {
        return [];
    }
    return resolvePluginContributionOwners({
        ...params,
        contribution: "providers",
        matches: (contributionId) => normalizeProviderId(contributionId) === providerId,
    });
}
export function resolveChannelOwners(params) {
    const channelId = normalizeContributionId(params.channelId);
    if (!channelId) {
        return [];
    }
    return resolvePluginContributionOwners({
        ...params,
        contribution: "channels",
        matches: channelId,
    });
}
export function resolveCliBackendOwners(params) {
    const cliBackendId = normalizeContributionId(params.cliBackendId);
    if (!cliBackendId) {
        return [];
    }
    return resolvePluginContributionOwners({
        ...params,
        contribution: "cliBackends",
        matches: cliBackendId,
    });
}
export function resolveSetupProviderOwners(params) {
    const setupProviderId = normalizeContributionId(params.setupProviderId);
    if (!setupProviderId) {
        return [];
    }
    return resolvePluginContributionOwners({
        ...params,
        contribution: "setupProviders",
        matches: setupProviderId,
    });
}
export function inspectPluginRegistry(params = {}) {
    return import("./installed-plugin-index-store.js").then((store) => store.inspectPersistedInstalledPluginIndex(params));
}
export function refreshPluginRegistry(params) {
    return import("./installed-plugin-index-store.js").then((store) => store.refreshPersistedInstalledPluginIndex(params));
}
