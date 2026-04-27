import { getChannelPluginCatalogEntry, listChannelPluginCatalogEntries, } from "../../channels/plugins/catalog.js";
import { applyPluginAutoEnable } from "../../config/plugin-auto-enable.js";
import { normalizePluginsConfig, resolveEnableState } from "../../plugins/config-state.js";
function resolveEffectiveTrustConfig(cfg, env) {
    return applyPluginAutoEnable({
        config: cfg,
        env: env ?? process.env,
    }).config;
}
function isTrustedWorkspaceChannelCatalogEntry(entry, cfg, env) {
    if (entry?.origin !== "workspace") {
        return true;
    }
    if (!entry.pluginId) {
        return false;
    }
    const effectiveConfig = resolveEffectiveTrustConfig(cfg, env);
    return resolveEnableState(entry.pluginId, "workspace", normalizePluginsConfig(effectiveConfig.plugins)).enabled;
}
export function getTrustedChannelPluginCatalogEntry(channelId, params) {
    const candidate = getChannelPluginCatalogEntry(channelId, {
        workspaceDir: params.workspaceDir,
    });
    if (isTrustedWorkspaceChannelCatalogEntry(candidate, params.cfg, params.env)) {
        return candidate;
    }
    return getChannelPluginCatalogEntry(channelId, {
        workspaceDir: params.workspaceDir,
        excludeWorkspace: true,
    });
}
function listChannelPluginCatalogEntriesWithTrustedFallback(params, onMissingFallback) {
    const unfiltered = listChannelPluginCatalogEntries({
        workspaceDir: params.workspaceDir,
    });
    const fallbackById = new Map(listChannelPluginCatalogEntries({
        workspaceDir: params.workspaceDir,
        excludeWorkspace: true,
    }).map((entry) => [entry.id, entry]));
    return unfiltered.flatMap((entry) => {
        if (isTrustedWorkspaceChannelCatalogEntry(entry, params.cfg, params.env)) {
            return [entry];
        }
        const fallback = fallbackById.get(entry.id);
        return fallback ? [fallback] : onMissingFallback(entry);
    });
}
export function listTrustedChannelPluginCatalogEntries(params) {
    return listChannelPluginCatalogEntriesWithTrustedFallback(params, () => []);
}
export function listSetupDiscoveryChannelPluginCatalogEntries(params) {
    return listChannelPluginCatalogEntriesWithTrustedFallback(params, (entry) => [entry]);
}
