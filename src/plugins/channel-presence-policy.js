import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import { hasMeaningfulChannelConfig, listPotentialConfiguredChannelPresenceSignals, } from "../channels/config-presence.js";
import { isSafeChannelEnvVarTriggerName } from "../secrets/channel-env-var-names.js";
import { normalizeOptionalLowercaseString } from "../shared/string-coerce.js";
import { resolveManifestActivationPluginIds } from "./activation-planner.js";
import { createPluginActivationSource, normalizePluginsConfig, resolveEffectivePluginActivationState, } from "./config-state.js";
import { hasExplicitManifestOwnerTrust, isActivatedManifestOwner, isBundledManifestOwner, passesManifestOwnerBasePolicy, } from "./manifest-owner-policy.js";
import { loadPluginManifestRegistry } from "./manifest-registry.js";
const IGNORED_CHANNEL_CONFIG_KEYS = new Set(["defaults", "modelByChannel"]);
function dedupeSortedPluginIds(values) {
    return [...new Set(values)].toSorted((left, right) => left.localeCompare(right));
}
function normalizeChannelIds(channelIds) {
    return Array.from(new Set([...channelIds]
        .map((channelId) => normalizeOptionalLowercaseString(channelId))
        .filter((channelId) => Boolean(channelId)))).toSorted((left, right) => left.localeCompare(right));
}
function hasNonEmptyEnvValue(env, key) {
    if (!isSafeChannelEnvVarTriggerName(key)) {
        return false;
    }
    const trimmed = key.trim();
    const value = env[trimmed] ?? env[trimmed.toUpperCase()];
    return typeof value === "string" && value.trim().length > 0;
}
export function hasExplicitChannelConfig(params) {
    const channels = params.config.channels;
    if (!channels || typeof channels !== "object" || Array.isArray(channels)) {
        return false;
    }
    const entry = channels[params.channelId];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        return false;
    }
    const enabled = entry.enabled;
    if (enabled === false) {
        return false;
    }
    return enabled === true || hasMeaningfulChannelConfig(entry);
}
export function listExplicitConfiguredChannelIdsForConfig(config) {
    const channels = config.channels;
    if (!channels || typeof channels !== "object" || Array.isArray(channels)) {
        return [];
    }
    return Object.keys(channels)
        .filter((channelId) => !IGNORED_CHANNEL_CONFIG_KEYS.has(channelId) &&
        hasExplicitChannelConfig({ config, channelId }))
        .toSorted((left, right) => left.localeCompare(right));
}
function recordDeclaresChannel(record, channelId) {
    const normalizedChannelId = normalizeOptionalLowercaseString(channelId) ?? "";
    if (!normalizedChannelId) {
        return false;
    }
    return record.channels.some((ownedChannelId) => (normalizeOptionalLowercaseString(ownedChannelId) ?? "") === normalizedChannelId);
}
function listManifestEnvConfiguredChannelSignals(params) {
    const signals = [];
    const seen = new Set();
    const trustConfig = params.activationSourceConfig ?? params.config;
    const normalizedConfig = normalizePluginsConfig(trustConfig.plugins);
    for (const record of params.records) {
        if (!isChannelPluginEligibleForScopedOwnership({
            plugin: record,
            normalizedConfig,
            rootConfig: trustConfig,
        })) {
            continue;
        }
        for (const channelId of record.channels) {
            const envVars = record.channelEnvVars?.[channelId] ?? [];
            if (!envVars.some((envVar) => hasNonEmptyEnvValue(params.env, envVar))) {
                continue;
            }
            if (seen.has(channelId)) {
                continue;
            }
            seen.add(channelId);
            signals.push({ channelId, source: "manifest-env" });
        }
    }
    return signals.toSorted((left, right) => left.channelId.localeCompare(right.channelId));
}
function normalizeActivationBlockedReason(reason) {
    switch (reason) {
        case "plugins disabled":
            return "plugins-disabled";
        case "blocked by denylist":
            return "blocked-by-denylist";
        case "disabled in config":
            return "plugin-disabled";
        case "not in allowlist":
            return "not-in-allowlist";
        case "workspace plugin (disabled by default)":
            return "workspace-disabled-by-default";
        case "bundled (disabled by default)":
            return "bundled-disabled-by-default";
        default:
            return "not-activated";
    }
}
function resolveBasePolicyBlockedReason(params) {
    if (!params.normalizedConfig.enabled) {
        return "plugins-disabled";
    }
    if (params.normalizedConfig.deny.includes(params.plugin.id)) {
        return "blocked-by-denylist";
    }
    if (params.normalizedConfig.entries[params.plugin.id]?.enabled === false) {
        return "plugin-disabled";
    }
    if (params.allowRestrictiveAllowlistBypass !== true &&
        params.normalizedConfig.allow.length > 0 &&
        !params.normalizedConfig.allow.includes(params.plugin.id)) {
        return "not-in-allowlist";
    }
    return null;
}
function isChannelPluginEligibleForScopedOwnership(params) {
    const allowRestrictiveAllowlistBypass = params.channelId !== undefined &&
        isBundledManifestOwner(params.plugin) &&
        hasExplicitChannelConfig({
            config: params.rootConfig,
            channelId: params.channelId,
        });
    if (!passesManifestOwnerBasePolicy({
        plugin: params.plugin,
        normalizedConfig: params.normalizedConfig,
        allowRestrictiveAllowlistBypass,
    })) {
        return false;
    }
    if (isBundledManifestOwner(params.plugin)) {
        return true;
    }
    if (params.plugin.origin === "global" || params.plugin.origin === "config") {
        return hasExplicitManifestOwnerTrust({
            plugin: params.plugin,
            normalizedConfig: params.normalizedConfig,
        });
    }
    return isActivatedManifestOwner({
        plugin: params.plugin,
        normalizedConfig: params.normalizedConfig,
        rootConfig: params.rootConfig,
    });
}
function evaluateEffectiveChannelPlugin(params) {
    const explicitBundledChannelConfig = isBundledManifestOwner(params.plugin) &&
        hasExplicitChannelConfig({
            config: params.activationSource.rootConfig ?? params.config,
            channelId: params.channelId,
        });
    const baseBlockedReason = resolveBasePolicyBlockedReason({
        plugin: params.plugin,
        normalizedConfig: params.normalizedConfig,
        allowRestrictiveAllowlistBypass: explicitBundledChannelConfig,
    });
    if (baseBlockedReason) {
        return {
            effective: false,
            pluginId: params.plugin.id,
            blockedReason: baseBlockedReason,
        };
    }
    if (!isBundledManifestOwner(params.plugin)) {
        if (params.plugin.origin === "global" || params.plugin.origin === "config") {
            const trusted = hasExplicitManifestOwnerTrust({
                plugin: params.plugin,
                normalizedConfig: params.normalizedConfig,
            });
            return trusted
                ? { effective: true, pluginId: params.plugin.id }
                : {
                    effective: false,
                    pluginId: params.plugin.id,
                    blockedReason: "untrusted-plugin",
                };
        }
        const activated = isActivatedManifestOwner({
            plugin: params.plugin,
            normalizedConfig: params.normalizedConfig,
            rootConfig: params.activationSource.rootConfig,
        });
        return activated
            ? { effective: true, pluginId: params.plugin.id }
            : {
                effective: false,
                pluginId: params.plugin.id,
                blockedReason: "untrusted-plugin",
            };
    }
    if (explicitBundledChannelConfig) {
        return { effective: true, pluginId: params.plugin.id };
    }
    const activationState = resolveEffectivePluginActivationState({
        id: params.plugin.id,
        origin: params.plugin.origin,
        config: params.normalizedConfig,
        rootConfig: params.config,
        enabledByDefault: params.plugin.enabledByDefault,
        activationSource: params.activationSource,
    });
    return activationState.enabled
        ? { effective: true, pluginId: params.plugin.id }
        : {
            effective: false,
            pluginId: params.plugin.id,
            blockedReason: normalizeActivationBlockedReason(activationState.reason),
        };
}
function addPolicySignal(entries, channelId, source) {
    const normalized = normalizeOptionalLowercaseString(channelId);
    if (!normalized) {
        return;
    }
    let sources = entries.get(normalized);
    if (!sources) {
        sources = new Set();
        entries.set(normalized, sources);
    }
    sources.add(source);
}
function listDisabledChannelIdsForConfig(config) {
    const channels = config.channels;
    if (!channels || typeof channels !== "object" || Array.isArray(channels)) {
        return [];
    }
    return Object.entries(channels)
        .filter(([, value]) => {
        return (value &&
            typeof value === "object" &&
            !Array.isArray(value) &&
            value.enabled === false);
    })
        .map(([channelId]) => normalizeOptionalLowercaseString(channelId))
        .filter((channelId) => Boolean(channelId));
}
export function resolveConfiguredChannelPresencePolicy(params) {
    const env = params.env ?? process.env;
    const workspaceDir = params.workspaceDir ??
        resolveAgentWorkspaceDir(params.config, resolveDefaultAgentId(params.config));
    const records = params.manifestRecords ??
        loadPluginManifestRegistry({
            config: params.config,
            workspaceDir,
            env,
            cache: params.cache,
        }).plugins;
    const disabledChannelIds = new Set(listDisabledChannelIdsForConfig(params.config));
    const entrySources = new Map();
    for (const channelId of listExplicitConfiguredChannelIdsForConfig(params.config)) {
        addPolicySignal(entrySources, channelId, "explicit-config");
    }
    for (const signal of listPotentialConfiguredChannelPresenceSignals(params.config, env, {
        includePersistedAuthState: params.includePersistedAuthState,
    })) {
        if (signal.source === "config") {
            continue;
        }
        addPolicySignal(entrySources, signal.channelId, signal.source);
    }
    for (const signal of listManifestEnvConfiguredChannelSignals({
        records,
        config: params.config,
        activationSourceConfig: params.activationSourceConfig,
        env,
    })) {
        addPolicySignal(entrySources, signal.channelId, signal.source);
    }
    for (const channelId of disabledChannelIds) {
        entrySources.delete(channelId);
    }
    const activationSource = createPluginActivationSource({
        config: params.activationSourceConfig ?? params.config,
    });
    const normalizedConfig = activationSource.plugins;
    const entries = [];
    for (const channelId of normalizeChannelIds(entrySources.keys())) {
        const owningRecords = records.filter((record) => recordDeclaresChannel(record, channelId));
        const evaluations = owningRecords.map((plugin) => evaluateEffectiveChannelPlugin({
            plugin,
            channelId,
            normalizedConfig,
            config: params.config,
            activationSource,
        }));
        const effectivePluginIds = evaluations
            .filter((entry) => entry.effective)
            .map((entry) => entry.pluginId);
        const blockedReasons = owningRecords.length === 0
            ? ["no-channel-owner"]
            : [
                ...new Set(evaluations
                    .map((entry) => entry.blockedReason)
                    .filter((reason) => Boolean(reason))),
            ].toSorted((left, right) => left.localeCompare(right));
        entries.push({
            channelId,
            sources: [...(entrySources.get(channelId) ?? [])].toSorted((left, right) => left.localeCompare(right)),
            effective: effectivePluginIds.length > 0,
            pluginIds: dedupeSortedPluginIds(effectivePluginIds),
            blockedReasons,
        });
    }
    return entries;
}
export function listConfiguredChannelIdsForReadOnlyScope(params) {
    return resolveConfiguredChannelPresencePolicy(params)
        .filter((entry) => entry.effective)
        .map((entry) => entry.channelId);
}
export function hasConfiguredChannelsForReadOnlyScope(params) {
    return listConfiguredChannelIdsForReadOnlyScope(params).length > 0;
}
export function listConfiguredAnnounceChannelIdsForConfig(params) {
    const disabledChannelIds = new Set(listDisabledChannelIdsForConfig(params.config));
    return normalizeChannelIds([
        ...listExplicitConfiguredChannelIdsForConfig(params.config),
        ...listConfiguredChannelIdsForReadOnlyScope({
            config: params.config,
            activationSourceConfig: params.activationSourceConfig,
            workspaceDir: params.workspaceDir,
            env: params.env,
            cache: params.cache,
            includePersistedAuthState: false,
        }),
    ]).filter((channelId) => !disabledChannelIds.has(channelId));
}
function resolveScopedChannelOwnerPluginIds(params) {
    const channelIds = normalizeChannelIds(params.channelIds);
    if (channelIds.length === 0) {
        return [];
    }
    const registry = loadPluginManifestRegistry({
        config: params.config,
        workspaceDir: params.workspaceDir,
        env: params.env,
        cache: params.cache,
    });
    const trustConfig = params.activationSourceConfig ?? params.config;
    const normalizedConfig = normalizePluginsConfig(trustConfig.plugins);
    const candidateIds = dedupeSortedPluginIds(channelIds.flatMap((channelId) => {
        return resolveManifestActivationPluginIds({
            trigger: {
                kind: "channel",
                channel: channelId,
            },
            config: params.config,
            workspaceDir: params.workspaceDir,
            env: params.env,
            cache: params.cache,
        });
    }));
    if (candidateIds.length === 0) {
        return [];
    }
    const candidateIdSet = new Set(candidateIds);
    return registry.plugins
        .filter((plugin) => {
        if (!candidateIdSet.has(plugin.id)) {
            return false;
        }
        return isChannelPluginEligibleForScopedOwnership({
            plugin,
            normalizedConfig,
            rootConfig: trustConfig,
            channelId: channelIds.find((channelId) => recordDeclaresChannel(plugin, channelId)),
        });
    })
        .map((plugin) => plugin.id)
        .toSorted((left, right) => left.localeCompare(right));
}
export function resolveDiscoverableScopedChannelPluginIds(params) {
    return resolveScopedChannelOwnerPluginIds(params);
}
export function resolveConfiguredChannelPluginIds(params) {
    const configuredChannelIds = normalizeChannelIds([
        ...listConfiguredChannelIdsForReadOnlyScope({
            config: params.config,
            activationSourceConfig: params.activationSourceConfig,
            workspaceDir: params.workspaceDir,
            env: params.env,
        }),
        ...listExplicitConfiguredChannelIdsForConfig(params.activationSourceConfig ?? params.config),
    ]);
    if (configuredChannelIds.length === 0) {
        return [];
    }
    return resolveScopedChannelOwnerPluginIds({
        ...params,
        channelIds: configuredChannelIds,
    });
}
