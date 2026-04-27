import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../../agents/agent-scope.js";
import { listChatChannels } from "../../channels/chat-meta.js";
import { isChannelVisibleInSetup } from "../../channels/plugins/exposure.js";
import { normalizeChannelMeta } from "../../channels/plugins/meta-normalization.js";
import { applyPluginAutoEnable } from "../../config/plugin-auto-enable.js";
import { listPluginContributionIds, loadPluginRegistrySnapshot, } from "../../plugins/plugin-registry.js";
import { listSetupDiscoveryChannelPluginCatalogEntries, listTrustedChannelPluginCatalogEntries, } from "./trusted-catalog.js";
export function shouldShowChannelInSetup(meta) {
    return isChannelVisibleInSetup(meta);
}
function resolveWorkspaceDir(cfg, workspaceDir) {
    return workspaceDir ?? resolveAgentWorkspaceDir(cfg, resolveDefaultAgentId(cfg));
}
export function listManifestInstalledChannelIds(params) {
    const resolvedConfig = applyPluginAutoEnable({
        config: params.cfg,
        env: params.env ?? process.env,
    }).config;
    const workspaceDir = resolveWorkspaceDir(resolvedConfig, params.workspaceDir);
    const index = loadPluginRegistrySnapshot({
        config: resolvedConfig,
        workspaceDir,
        env: params.env ?? process.env,
    });
    return new Set(listPluginContributionIds({ index, contribution: "channels", config: resolvedConfig }).map((channelId) => channelId));
}
export function isCatalogChannelInstalled(params) {
    return listManifestInstalledChannelIds(params).has(params.entry.id);
}
export function resolveChannelSetupEntries(params) {
    const workspaceDir = resolveWorkspaceDir(params.cfg, params.workspaceDir);
    const manifestInstalledIds = listManifestInstalledChannelIds({
        cfg: params.cfg,
        workspaceDir,
        env: params.env,
    });
    const installedPluginIds = new Set(params.installedPlugins.map((plugin) => plugin.id));
    // Discovery keeps workspace-only install candidates visible, while the
    // installed bucket must still reflect what setup can safely auto-load.
    const installedCatalogEntriesSource = listTrustedChannelPluginCatalogEntries({
        cfg: params.cfg,
        workspaceDir,
        env: params.env,
    });
    const installableCatalogEntriesSource = listSetupDiscoveryChannelPluginCatalogEntries({
        cfg: params.cfg,
        workspaceDir,
        env: params.env,
    });
    const installedCatalogEntries = installedCatalogEntriesSource
        .filter((entry) => !installedPluginIds.has(entry.id) &&
        manifestInstalledIds.has(entry.id) &&
        shouldShowChannelInSetup(entry.meta))
        .map((entry) => Object.assign({}, entry, {
        meta: normalizeChannelMeta({ id: entry.id, meta: entry.meta }),
    }));
    const installableCatalogEntries = installableCatalogEntriesSource
        .filter((entry) => !installedPluginIds.has(entry.id) &&
        !manifestInstalledIds.has(entry.id) &&
        shouldShowChannelInSetup(entry.meta))
        .map((entry) => Object.assign({}, entry, {
        meta: normalizeChannelMeta({ id: entry.id, meta: entry.meta }),
    }));
    const metaById = new Map();
    for (const meta of listChatChannels()) {
        metaById.set(meta.id, normalizeChannelMeta({
            id: meta.id,
            meta,
        }));
    }
    for (const plugin of params.installedPlugins) {
        metaById.set(plugin.id, normalizeChannelMeta({
            id: plugin.id,
            meta: plugin.meta,
            existing: metaById.get(plugin.id),
        }));
    }
    for (const entry of installedCatalogEntries) {
        if (!metaById.has(entry.id)) {
            metaById.set(entry.id, normalizeChannelMeta({
                id: entry.id,
                meta: entry.meta,
                existing: metaById.get(entry.id),
            }));
        }
    }
    for (const entry of installableCatalogEntries) {
        if (!metaById.has(entry.id)) {
            metaById.set(entry.id, normalizeChannelMeta({
                id: entry.id,
                meta: entry.meta,
                existing: metaById.get(entry.id),
            }));
        }
    }
    return {
        entries: Array.from(metaById, ([id, meta]) => ({
            id: id,
            meta,
        })).filter((entry) => shouldShowChannelInSetup(entry.meta)),
        installedCatalogEntries,
        installableCatalogEntries,
        installedCatalogById: new Map(installedCatalogEntries.map((entry) => [entry.id, entry])),
        installableCatalogById: new Map(installableCatalogEntries.map((entry) => [entry.id, entry])),
    };
}
