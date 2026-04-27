import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../../agents/agent-scope.js";
import { isBlockedObjectKey } from "../../infra/prototype-keys.js";
import { hasExplicitChannelConfig, listConfiguredChannelIdsForReadOnlyScope, resolveDiscoverableScopedChannelPluginIds, } from "../../plugins/channel-plugin-ids.js";
import { loadOpenClawPlugins } from "../../plugins/loader.js";
import { loadPluginManifestRegistry, } from "../../plugins/manifest-registry.js";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "../../routing/session-key.js";
import { sanitizeForLog } from "../../terminal/ansi.js";
import { getBundledChannelSetupPlugin } from "./bundled.js";
import { listChannelPlugins } from "./registry.js";
const SAFE_MANIFEST_CHANNEL_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
function addChannelPlugins(byId, plugins, options) {
    for (const plugin of plugins) {
        if (!plugin) {
            continue;
        }
        if (options?.onlyIds && !options.onlyIds.has(plugin.id)) {
            continue;
        }
        if (options?.allowOverwrite === false && byId.has(plugin.id)) {
            continue;
        }
        byId.set(plugin.id, plugin);
    }
}
function rebindChannelScopedString(value, sourceChannelId, targetChannelId) {
    const sourcePrefix = `channels.${sourceChannelId}`;
    if (value === sourcePrefix) {
        return `channels.${targetChannelId}`;
    }
    if (value.startsWith(`${sourcePrefix}.`)) {
        return `channels.${targetChannelId}${value.slice(sourcePrefix.length)}`;
    }
    return value;
}
function isSafeManifestChannelId(channelId) {
    return SAFE_MANIFEST_CHANNEL_ID_PATTERN.test(channelId) && !isBlockedObjectKey(channelId);
}
function readOwnRecordValue(record, key) {
    if (isBlockedObjectKey(key) || !Object.prototype.hasOwnProperty.call(record, key)) {
        return undefined;
    }
    return record[key];
}
function normalizeManifestText(value, fallback) {
    return sanitizeForLog(value?.trim() || fallback).trim();
}
function rebindChannelConfig(cfg, sourceChannelId, targetChannelId) {
    if (sourceChannelId === targetChannelId || !cfg.channels) {
        return cfg;
    }
    return {
        ...cfg,
        channels: {
            ...cfg.channels,
            [sourceChannelId]: cfg.channels[targetChannelId],
        },
    };
}
function restoreReboundChannelConfig(params) {
    if (params.sourceChannelId === params.targetChannelId || !params.updated.channels) {
        return params.updated;
    }
    const nextChannels = { ...params.updated.channels };
    if (Object.prototype.hasOwnProperty.call(nextChannels, params.sourceChannelId)) {
        nextChannels[params.targetChannelId] = nextChannels[params.sourceChannelId];
    }
    else {
        delete nextChannels[params.targetChannelId];
    }
    if (params.original.channels &&
        Object.prototype.hasOwnProperty.call(params.original.channels, params.sourceChannelId)) {
        nextChannels[params.sourceChannelId] = params.original.channels[params.sourceChannelId];
    }
    else {
        delete nextChannels[params.sourceChannelId];
    }
    return {
        ...params.updated,
        channels: nextChannels,
    };
}
function getChannelConfigRecord(cfg, channelId) {
    if (!isSafeManifestChannelId(channelId)) {
        return {};
    }
    const channels = cfg.channels;
    if (!channels || typeof channels !== "object" || Array.isArray(channels)) {
        return {};
    }
    const entry = readOwnRecordValue(channels, channelId);
    return entry && typeof entry === "object" && !Array.isArray(entry)
        ? entry
        : {};
}
function listManifestChannelAccountIds(cfg, channelId) {
    const channelConfig = getChannelConfigRecord(cfg, channelId);
    const accounts = channelConfig.accounts;
    if (accounts && typeof accounts === "object" && !Array.isArray(accounts)) {
        return [
            ...new Set(Object.keys(accounts)
                .filter((accountId) => !isBlockedObjectKey(accountId))
                .map((accountId) => normalizeAccountId(accountId))
                .filter((accountId) => !isBlockedObjectKey(accountId))),
        ].toSorted((left, right) => left.localeCompare(right));
    }
    return hasExplicitChannelConfig({ config: cfg, channelId }) ? [DEFAULT_ACCOUNT_ID] : [];
}
function resolveManifestChannelAccountConfig(params) {
    const channelConfig = getChannelConfigRecord(params.cfg, params.channelId);
    const resolvedAccountId = normalizeAccountId(params.accountId);
    const accounts = channelConfig.accounts;
    if (accounts && typeof accounts === "object" && !Array.isArray(accounts)) {
        const accountConfig = readOwnRecordValue(accounts, resolvedAccountId);
        if (accountConfig && typeof accountConfig === "object" && !Array.isArray(accountConfig)) {
            return accountConfig;
        }
    }
    return channelConfig;
}
function buildManifestChannelPlugin(params) {
    if (!isSafeManifestChannelId(params.channelId)) {
        return undefined;
    }
    const channelConfigValue = params.record.channelConfigs
        ? readOwnRecordValue(params.record.channelConfigs, params.channelId)
        : undefined;
    if (!channelConfigValue ||
        typeof channelConfigValue !== "object" ||
        Array.isArray(channelConfigValue)) {
        return undefined;
    }
    const channelConfig = channelConfigValue;
    const label = normalizeManifestText(channelConfig.label, params.record.name || params.channelId) ||
        params.channelId;
    const blurb = normalizeManifestText(channelConfig.description, params.record.description || "");
    return {
        id: params.channelId,
        meta: {
            id: params.channelId,
            label,
            selectionLabel: label,
            docsPath: `/channels/${encodeURIComponent(params.channelId)}`,
            blurb,
            ...(channelConfig.preferOver?.length ? { preferOver: channelConfig.preferOver } : {}),
        },
        capabilities: { chatTypes: ["direct"] },
        configSchema: {
            schema: channelConfig.schema,
            ...(channelConfig.uiHints ? { uiHints: channelConfig.uiHints } : {}),
            ...(channelConfig.runtime ? { runtime: channelConfig.runtime } : {}),
        },
        config: {
            listAccountIds: (cfg) => listManifestChannelAccountIds(cfg, params.channelId),
            defaultAccountId: () => DEFAULT_ACCOUNT_ID,
            resolveAccount: (cfg, accountId) => ({
                accountId: normalizeAccountId(accountId),
                config: resolveManifestChannelAccountConfig({
                    cfg,
                    channelId: params.channelId,
                    accountId,
                }),
            }),
            isEnabled: (_account, cfg) => getChannelConfigRecord(cfg, params.channelId).enabled !== false,
            isConfigured: (_account, cfg) => hasExplicitChannelConfig({
                config: cfg,
                channelId: params.channelId,
            }),
            hasConfiguredState: ({ cfg }) => hasExplicitChannelConfig({
                config: cfg,
                channelId: params.channelId,
            }),
        },
    };
}
function canUseManifestChannelPlugin(record) {
    return record.setup?.requiresRuntime === false || !record.setupSource;
}
function rebindChannelPluginConfig(config, sourceChannelId, targetChannelId) {
    const rebind = (cfg) => rebindChannelConfig(cfg, sourceChannelId, targetChannelId);
    return {
        ...config,
        listAccountIds: (cfg) => config.listAccountIds(rebind(cfg)),
        resolveAccount: (cfg, accountId) => config.resolveAccount(rebind(cfg), accountId),
        inspectAccount: config.inspectAccount
            ? (cfg, accountId) => config.inspectAccount?.(rebind(cfg), accountId)
            : undefined,
        defaultAccountId: config.defaultAccountId
            ? (cfg) => config.defaultAccountId?.(rebind(cfg)) ?? ""
            : undefined,
        setAccountEnabled: config.setAccountEnabled
            ? (params) => restoreReboundChannelConfig({
                original: params.cfg,
                updated: config.setAccountEnabled?.({ ...params, cfg: rebind(params.cfg) }) ?? params.cfg,
                sourceChannelId,
                targetChannelId,
            })
            : undefined,
        deleteAccount: config.deleteAccount
            ? (params) => restoreReboundChannelConfig({
                original: params.cfg,
                updated: config.deleteAccount?.({ ...params, cfg: rebind(params.cfg) }) ?? params.cfg,
                sourceChannelId,
                targetChannelId,
            })
            : undefined,
        isEnabled: config.isEnabled
            ? (account, cfg) => config.isEnabled?.(account, rebind(cfg)) ?? false
            : undefined,
        disabledReason: config.disabledReason
            ? (account, cfg) => config.disabledReason?.(account, rebind(cfg)) ?? ""
            : undefined,
        isConfigured: config.isConfigured
            ? (account, cfg) => config.isConfigured?.(account, rebind(cfg)) ?? false
            : undefined,
        unconfiguredReason: config.unconfiguredReason
            ? (account, cfg) => config.unconfiguredReason?.(account, rebind(cfg)) ?? ""
            : undefined,
        describeAccount: config.describeAccount
            ? (account, cfg) => config.describeAccount(account, rebind(cfg))
            : undefined,
        resolveAllowFrom: config.resolveAllowFrom
            ? (params) => config.resolveAllowFrom?.({ ...params, cfg: rebind(params.cfg) })
            : undefined,
        formatAllowFrom: config.formatAllowFrom
            ? (params) => config.formatAllowFrom?.({ ...params, cfg: rebind(params.cfg) }) ?? []
            : undefined,
        hasConfiguredState: config.hasConfiguredState
            ? (params) => config.hasConfiguredState?.({ ...params, cfg: rebind(params.cfg) }) ?? false
            : undefined,
        hasPersistedAuthState: config.hasPersistedAuthState
            ? (params) => config.hasPersistedAuthState?.({ ...params, cfg: rebind(params.cfg) }) ?? false
            : undefined,
        resolveDefaultTo: config.resolveDefaultTo
            ? (params) => config.resolveDefaultTo?.({ ...params, cfg: rebind(params.cfg) })
            : undefined,
    };
}
function rebindChannelPluginSecrets(secrets, sourceChannelId, targetChannelId) {
    if (!secrets) {
        return undefined;
    }
    return {
        ...secrets,
        secretTargetRegistryEntries: secrets.secretTargetRegistryEntries?.map((entry) => ({
            ...entry,
            id: rebindChannelScopedString(entry.id, sourceChannelId, targetChannelId),
            pathPattern: rebindChannelScopedString(entry.pathPattern, sourceChannelId, targetChannelId),
            ...(entry.refPathPattern
                ? {
                    refPathPattern: rebindChannelScopedString(entry.refPathPattern, sourceChannelId, targetChannelId),
                }
                : {}),
        })),
        unsupportedSecretRefSurfacePatterns: secrets.unsupportedSecretRefSurfacePatterns?.map((pattern) => rebindChannelScopedString(pattern, sourceChannelId, targetChannelId)),
        collectRuntimeConfigAssignments: secrets.collectRuntimeConfigAssignments
            ? (params) => secrets.collectRuntimeConfigAssignments?.({
                ...params,
                config: rebindChannelConfig(params.config, sourceChannelId, targetChannelId),
            })
            : undefined,
    };
}
function cloneChannelPluginForChannelId(plugin, channelId) {
    if (plugin.id === channelId && plugin.meta.id === channelId) {
        return plugin;
    }
    const sourceChannelId = plugin.id;
    return {
        ...plugin,
        id: channelId,
        meta: {
            ...plugin.meta,
            id: channelId,
        },
        config: rebindChannelPluginConfig(plugin.config, sourceChannelId, channelId),
        secrets: rebindChannelPluginSecrets(plugin.secrets, sourceChannelId, channelId),
    };
}
function addSetupChannelPlugins(byId, setups, options) {
    for (const setup of setups) {
        const ownedMissingChannelIds = options.ownedMissingChannelIdsByPluginId
            .get(setup.pluginId)
            ?.filter(isSafeManifestChannelId);
        if (!ownedMissingChannelIds || ownedMissingChannelIds.length === 0) {
            continue;
        }
        if (ownedMissingChannelIds.includes(setup.plugin.id)) {
            addChannelPlugins(byId, [setup.plugin], {
                onlyIds: new Set(ownedMissingChannelIds),
                allowOverwrite: false,
            });
            addChannelPlugins(byId, ownedMissingChannelIds
                .filter((channelId) => channelId !== setup.plugin.id)
                .map((channelId) => cloneChannelPluginForChannelId(setup.plugin, channelId)), {
                onlyIds: new Set(ownedMissingChannelIds),
                allowOverwrite: false,
            });
            continue;
        }
        const ownedChannelIds = (options.ownedChannelIdsByPluginId.get(setup.pluginId) ?? []).filter(isSafeManifestChannelId);
        if (setup.plugin.id !== setup.pluginId && !ownedChannelIds.includes(setup.plugin.id)) {
            continue;
        }
        addChannelPlugins(byId, ownedMissingChannelIds.map((channelId) => cloneChannelPluginForChannelId(setup.plugin, channelId)), {
            onlyIds: new Set(ownedMissingChannelIds),
            allowOverwrite: false,
        });
    }
}
function addManifestChannelPlugins(byId, records, options) {
    const channelIds = new Set(options.channelIds);
    for (const record of records) {
        if (!options.pluginIds.has(record.id)) {
            continue;
        }
        if (!canUseManifestChannelPlugin(record)) {
            continue;
        }
        for (const channelId of record.channels) {
            if (!isSafeManifestChannelId(channelId)) {
                continue;
            }
            if (!channelIds.has(channelId)) {
                continue;
            }
            addChannelPlugins(byId, [buildManifestChannelPlugin({ record, channelId })], {
                onlyIds: channelIds,
                allowOverwrite: false,
            });
        }
    }
}
function resolveReadOnlyWorkspaceDir(cfg, options) {
    return options.workspaceDir ?? resolveAgentWorkspaceDir(cfg, resolveDefaultAgentId(cfg));
}
function listExternalChannelManifestRecords(records) {
    return records.filter((plugin) => plugin.origin !== "bundled" && plugin.channels.length > 0);
}
function resolveExternalReadOnlyChannelPluginIds(params) {
    if (params.channelIds.length === 0) {
        return [];
    }
    const candidatePluginIds = resolveDiscoverableScopedChannelPluginIds({
        config: params.cfg,
        activationSourceConfig: params.activationSourceConfig,
        channelIds: params.channelIds,
        workspaceDir: params.workspaceDir,
        env: params.env,
        cache: params.cache,
    });
    if (candidatePluginIds.length === 0) {
        return [];
    }
    const requestedChannelIds = new Set(params.channelIds);
    const candidatePluginIdSet = new Set(candidatePluginIds);
    return params.records
        .filter((plugin) => candidatePluginIdSet.has(plugin.id) &&
        plugin.channels.some((channelId) => requestedChannelIds.has(channelId)))
        .map((plugin) => plugin.id)
        .toSorted((left, right) => left.localeCompare(right));
}
export function listReadOnlyChannelPluginsForConfig(cfg, options) {
    return resolveReadOnlyChannelPluginsForConfig(cfg, options).plugins;
}
export function resolveReadOnlyChannelPluginsForConfig(cfg, options = {}) {
    const env = options.env ?? process.env;
    const workspaceDir = resolveReadOnlyWorkspaceDir(cfg, options);
    const manifestRecords = loadPluginManifestRegistry({
        config: cfg,
        workspaceDir,
        env,
        cache: options.cache,
    }).plugins;
    const externalManifestRecords = listExternalChannelManifestRecords(manifestRecords);
    const configuredChannelIds = [
        ...new Set(listConfiguredChannelIdsForReadOnlyScope({
            config: cfg,
            activationSourceConfig: options.activationSourceConfig ?? cfg,
            workspaceDir,
            env,
            cache: options.cache,
            includePersistedAuthState: options.includePersistedAuthState,
            manifestRecords,
        })),
    ].filter(isSafeManifestChannelId);
    const byId = new Map();
    addChannelPlugins(byId, listChannelPlugins());
    for (const channelId of configuredChannelIds) {
        if (byId.has(channelId)) {
            continue;
        }
        addChannelPlugins(byId, [getBundledChannelSetupPlugin(channelId)]);
    }
    const missingConfiguredChannelIds = configuredChannelIds.filter((channelId) => !byId.has(channelId));
    const externalPluginIds = resolveExternalReadOnlyChannelPluginIds({
        cfg,
        activationSourceConfig: options.activationSourceConfig ?? cfg,
        channelIds: missingConfiguredChannelIds,
        records: externalManifestRecords,
        workspaceDir,
        env,
        cache: options.cache,
    });
    if (externalPluginIds.length > 0) {
        const externalPluginIdSet = new Set(externalPluginIds);
        addManifestChannelPlugins(byId, externalManifestRecords, {
            pluginIds: externalPluginIdSet,
            channelIds: missingConfiguredChannelIds,
        });
        const setupMissingChannelIds = missingConfiguredChannelIds.filter((channelId) => !byId.has(channelId));
        const missingChannelIdSet = new Set(setupMissingChannelIds);
        const ownedChannelIdsByPluginId = new Map(externalManifestRecords
            .filter((record) => externalPluginIdSet.has(record.id))
            .map((record) => [record.id, record.channels]));
        const ownedMissingChannelIdsByPluginId = new Map([...ownedChannelIdsByPluginId].map(([pluginId, channelIds]) => [pluginId, channelIds.filter((channelId) => missingChannelIdSet.has(channelId))]));
        if (setupMissingChannelIds.length > 0) {
            const registry = loadOpenClawPlugins({
                config: cfg,
                activationSourceConfig: options.activationSourceConfig ?? cfg,
                env,
                workspaceDir,
                cache: false,
                activate: false,
                includeSetupOnlyChannelPlugins: true,
                forceSetupOnlyChannelPlugins: true,
                requireSetupEntryForSetupOnlyChannelPlugins: true,
                onlyPluginIds: externalPluginIds,
            });
            addSetupChannelPlugins(byId, registry.channelSetups, {
                ownedChannelIdsByPluginId,
                ownedMissingChannelIdsByPluginId,
            });
        }
    }
    const plugins = [...byId.values()];
    return {
        plugins,
        configuredChannelIds,
        missingConfiguredChannelIds: configuredChannelIds.filter((channelId) => !byId.has(channelId)),
    };
}
