import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../../agents/agent-scope.js";
import { applyPluginAutoEnable } from "../../config/plugin-auto-enable.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { resolveDiscoverableScopedChannelPluginIds } from "../../plugins/channel-plugin-ids.js";
import { clearPluginDiscoveryCache } from "../../plugins/discovery.js";
import { loadOpenClawPlugins } from "../../plugins/loader.js";
import { createPluginLoaderLogger } from "../../plugins/logger.js";
import { getActivePluginChannelRegistry } from "../../plugins/runtime.js";
import { ensureOnboardingPluginInstalled, } from "../onboarding-plugin-install.js";
import { getTrustedChannelPluginCatalogEntry } from "./trusted-catalog.js";
function toOnboardingPluginInstallEntry(entry) {
    return {
        pluginId: entry.pluginId ?? entry.id,
        label: entry.meta.label,
        install: entry.install,
    };
}
export async function ensureChannelSetupPluginInstalled(params) {
    const result = await ensureOnboardingPluginInstalled({
        cfg: params.cfg,
        entry: toOnboardingPluginInstallEntry(params.entry),
        prompter: params.prompter,
        runtime: params.runtime,
        workspaceDir: params.workspaceDir,
    });
    return {
        cfg: result.cfg,
        installed: result.installed,
        pluginId: result.pluginId,
        status: result.status,
    };
}
export function reloadChannelSetupPluginRegistry(params) {
    loadChannelSetupPluginRegistry(params);
}
function loadChannelSetupPluginRegistry(params) {
    clearPluginDiscoveryCache();
    const autoEnabled = applyPluginAutoEnable({ config: params.cfg, env: process.env });
    const resolvedConfig = autoEnabled.config;
    const workspaceDir = params.workspaceDir ??
        resolveAgentWorkspaceDir(resolvedConfig, resolveDefaultAgentId(resolvedConfig));
    const log = createSubsystemLogger("plugins");
    return loadOpenClawPlugins({
        config: resolvedConfig,
        activationSourceConfig: params.cfg,
        autoEnabledReasons: autoEnabled.autoEnabledReasons,
        workspaceDir,
        cache: false,
        logger: createPluginLoaderLogger(log),
        onlyPluginIds: params.onlyPluginIds,
        includeSetupOnlyChannelPlugins: true,
        forceSetupOnlyChannelPlugins: params.forceSetupOnlyChannelPlugins ?? params.installRuntimeDeps === false,
        activate: params.activate,
        installBundledRuntimeDeps: params.installRuntimeDeps !== false,
    });
}
function resolveScopedChannelPluginId(params) {
    const explicitPluginId = params.pluginId?.trim();
    if (explicitPluginId) {
        return explicitPluginId;
    }
    return (getTrustedChannelPluginCatalogEntry(params.channel, {
        cfg: params.cfg,
        workspaceDir: params.workspaceDir,
    })?.pluginId ?? resolveUniqueManifestScopedChannelPluginId(params));
}
function resolveUniqueManifestScopedChannelPluginId(params) {
    const matches = resolveDiscoverableScopedChannelPluginIds({
        config: params.cfg,
        channelIds: [params.channel],
        workspaceDir: params.workspaceDir,
        env: process.env,
        cache: false,
    });
    return matches.length === 1 ? matches[0] : undefined;
}
export function reloadChannelSetupPluginRegistryForChannel(params) {
    const activeRegistry = getActivePluginChannelRegistry();
    const scopedPluginId = resolveScopedChannelPluginId({
        cfg: params.cfg,
        channel: params.channel,
        pluginId: params.pluginId,
        workspaceDir: params.workspaceDir,
    });
    // On low-memory hosts, the empty-registry fallback should only recover the selected
    // plugin when we have a trusted channel -> plugin mapping. Otherwise fall back
    // to an unscoped reload instead of trusting manifest-declared channel ids.
    const onlyPluginIds = activeRegistry?.plugins.length || !scopedPluginId ? undefined : [scopedPluginId];
    loadChannelSetupPluginRegistry({
        ...params,
        onlyPluginIds,
    });
}
export function loadChannelSetupPluginRegistrySnapshotForChannel(params) {
    const scopedPluginId = resolveScopedChannelPluginId({
        cfg: params.cfg,
        channel: params.channel,
        pluginId: params.pluginId,
        workspaceDir: params.workspaceDir,
    });
    return loadChannelSetupPluginRegistry({
        ...params,
        ...(scopedPluginId ? { onlyPluginIds: [scopedPluginId] } : {}),
        activate: false,
    });
}
