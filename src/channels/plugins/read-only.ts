/** Read-only channel plugin discovery from the process-stable metadata snapshot. */
import path from "node:path";
import {
  sortUniqueStrings,
  uniqueStrings,
} from "@openclaw/normalization-core/string-normalization";
import { sanitizeForLog } from "../../../packages/terminal-core/src/ansi.js";
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../../agents/agent-scope.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { isBlockedObjectKey } from "../../infra/prototype-keys.js";
import {
  hasExplicitChannelConfig,
  listConfiguredChannelIdsForReadOnlyScope,
  resolveDiscoverableScopedChannelPluginIds,
} from "../../plugins/channel-plugin-ids.js";
import {
  channelPluginIdBelongsToManifest,
  resolveSetupChannelRegistration,
} from "../../plugins/loader-channel-setup.js";
import type { PluginManifestRecord } from "../../plugins/manifest-registry.js";
import { resolvePluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.js";
import { loadPluginPublicArtifactModuleSync } from "../../plugins/public-surface-loader.js";
import { resolveNormalizedAccountEntry } from "../../routing/account-lookup.js";
import {
  DEFAULT_ACCOUNT_ID,
  normalizeAccountId,
  normalizeOptionalAccountId,
} from "../../routing/session-key.js";
import { resolveListedDefaultAccountId } from "./account-helpers.js";
import { getBundledChannelSetupPlugin } from "./bundled.js";
import {
  isSafeManifestChannelId,
  normalizeChannelCommandDefaults,
  readOwnRecordValue,
  resolveReadOnlyChannelCommandDefaults,
} from "./read-only-command-defaults.js";
import { listChannelPlugins } from "./registry.js";
import type { ChannelPlugin } from "./types.plugin.js";

type ReadOnlyChannelPluginOptions = {
  env?: NodeJS.ProcessEnv;
  stateDir?: string;
  workspaceDir?: string;
  activationSourceConfig?: OpenClawConfig;
  includePersistedAuthState?: boolean;
  includeSetupFallbackPlugins?: boolean;
};

type ReadOnlyChannelPluginLoadFailure = {
  channelId: string;
  pluginId: string;
  message: string;
  source?: string;
};

type ReadOnlyChannelPluginResolution = {
  plugins: ChannelPlugin[];
  configuredChannelIds: string[];
  missingConfiguredChannelIds: string[];
  loadFailures: ReadOnlyChannelPluginLoadFailure[];
};

type ManifestChannelConfigRecord = NonNullable<PluginManifestRecord["channelConfigs"]>[string];

export { resolveReadOnlyChannelCommandDefaults };

function getChannelConfigRecord(cfg: OpenClawConfig, channelId: string): Record<string, unknown> {
  if (!isSafeManifestChannelId(channelId)) {
    return {};
  }
  const channels = cfg.channels;
  if (!channels || typeof channels !== "object" || Array.isArray(channels)) {
    return {};
  }
  const entry = readOwnRecordValue(channels as Record<string, unknown>, channelId);
  return entry && typeof entry === "object" && !Array.isArray(entry)
    ? (entry as Record<string, unknown>)
    : {};
}

function listManifestChannelAccountIds(cfg: OpenClawConfig, channelId: string): string[] {
  const accounts = getChannelConfigRecord(cfg, channelId).accounts;
  if (accounts && typeof accounts === "object" && !Array.isArray(accounts)) {
    return sortUniqueStrings(
      Object.keys(accounts)
        .filter((accountId) => !isBlockedObjectKey(accountId))
        .map(normalizeOptionalAccountId)
        .filter((accountId): accountId is string => Boolean(accountId)),
    );
  }
  return hasExplicitChannelConfig({ config: cfg, channelId }) ? [DEFAULT_ACCOUNT_ID] : [];
}

function resolveManifestChannelDefaultAccountId(cfg: OpenClawConfig, channelId: string): string {
  const configuredDefault = getChannelConfigRecord(cfg, channelId).defaultAccount;
  return resolveListedDefaultAccountId({
    accountIds: listManifestChannelAccountIds(cfg, channelId),
    configuredDefaultAccountId: normalizeOptionalAccountId(
      typeof configuredDefault === "string" ? configuredDefault : undefined,
    ),
  });
}

function resolveManifestChannelAccountConfig(params: {
  cfg: OpenClawConfig;
  channelId: string;
  accountId?: string | null;
}): Record<string, unknown> {
  const channelConfig = getChannelConfigRecord(params.cfg, params.channelId);
  const accounts = channelConfig.accounts;
  if (accounts && typeof accounts === "object" && !Array.isArray(accounts)) {
    const accountConfig = resolveNormalizedAccountEntry(
      accounts as Record<string, unknown>,
      normalizeAccountId(params.accountId),
      (accountId) => normalizeOptionalAccountId(accountId) ?? "",
    );
    if (accountConfig && typeof accountConfig === "object" && !Array.isArray(accountConfig)) {
      return accountConfig as Record<string, unknown>;
    }
  }
  return channelConfig;
}

function buildManifestChannelPlugin(
  record: PluginManifestRecord,
  channelId: string,
): ChannelPlugin | undefined {
  if (!isSafeManifestChannelId(channelId)) {
    return undefined;
  }
  const catalogMeta =
    record.channelCatalogMeta?.id === channelId ? record.channelCatalogMeta : undefined;
  const configValue = record.channelConfigs
    ? readOwnRecordValue(record.channelConfigs as Record<string, unknown>, channelId)
    : undefined;
  const channelConfig =
    configValue && typeof configValue === "object" && !Array.isArray(configValue)
      ? (configValue as ManifestChannelConfigRecord)
      : undefined;
  if (!catalogMeta && !channelConfig && !record.channels.includes(channelId)) {
    return undefined;
  }
  const labelSource = channelConfig?.label ?? catalogMeta?.label;
  const blurbSource = channelConfig?.description ?? catalogMeta?.blurb;
  const label = sanitizeForLog(labelSource?.trim() || record.name || channelId).trim();
  const blurb = sanitizeForLog(blurbSource?.trim() || record.description || "").trim();
  const commands = normalizeChannelCommandDefaults(
    channelConfig?.commands ?? catalogMeta?.commands,
  );
  return {
    id: channelId,
    meta: {
      id: channelId,
      label: label || channelId,
      selectionLabel: label || channelId,
      docsPath: `/channels/${encodeURIComponent(channelId)}`,
      blurb,
      ...(channelConfig?.preferOver?.length
        ? { preferOver: channelConfig.preferOver }
        : catalogMeta?.preferOver?.length
          ? { preferOver: catalogMeta.preferOver }
          : {}),
    },
    capabilities: { chatTypes: ["direct"] },
    ...(commands ? { commands } : {}),
    ...(channelConfig
      ? {
          configSchema: {
            schema: channelConfig.schema,
            ...(channelConfig.uiHints ? { uiHints: channelConfig.uiHints } : {}),
            ...(channelConfig.runtime ? { runtime: channelConfig.runtime } : {}),
          },
        }
      : {}),
    config: {
      listAccountIds: (cfg) => listManifestChannelAccountIds(cfg, channelId),
      defaultAccountId: (cfg) => resolveManifestChannelDefaultAccountId(cfg, channelId),
      resolveAccount: (cfg, accountId) => ({
        accountId: normalizeAccountId(accountId),
        config: resolveManifestChannelAccountConfig({ cfg, channelId, accountId }),
      }),
      isEnabled: (_account, cfg) => getChannelConfigRecord(cfg, channelId).enabled !== false,
      isConfigured: (_account, cfg) => hasExplicitChannelConfig({ config: cfg, channelId }),
      hasConfiguredState: ({ cfg }) => hasExplicitChannelConfig({ config: cfg, channelId }),
    },
  };
}

function canUseManifestChannelPlugin(record: PluginManifestRecord, channelId: string): boolean {
  if (record.channelConfigs && Object.hasOwn(record.channelConfigs, channelId)) {
    return record.setup?.requiresRuntime === false || !record.setupSource;
  }
  return record.channelCatalogMeta?.id === channelId || !record.setupSource;
}

function rebindChannelConfig(
  cfg: OpenClawConfig,
  sourceChannelId: string,
  targetChannelId: string,
): OpenClawConfig {
  if (sourceChannelId === targetChannelId || !cfg.channels) {
    return cfg;
  }
  return {
    ...cfg,
    channels: { ...cfg.channels, [sourceChannelId]: cfg.channels[targetChannelId] },
  };
}

function restoreReboundChannelConfig(params: {
  original: OpenClawConfig;
  updated: OpenClawConfig;
  sourceChannelId: string;
  targetChannelId: string;
}): OpenClawConfig {
  if (params.sourceChannelId === params.targetChannelId || !params.updated.channels) {
    return params.updated;
  }
  const channels = { ...params.updated.channels };
  if (Object.hasOwn(channels, params.sourceChannelId)) {
    channels[params.targetChannelId] = channels[params.sourceChannelId];
  } else {
    delete channels[params.targetChannelId];
  }
  if (params.original.channels && Object.hasOwn(params.original.channels, params.sourceChannelId)) {
    channels[params.sourceChannelId] = params.original.channels[params.sourceChannelId];
  } else {
    delete channels[params.sourceChannelId];
  }
  return { ...params.updated, channels };
}

function rebindFirstConfig<TArgs extends unknown[], TResult>(
  callback: ((cfg: OpenClawConfig, ...args: TArgs) => TResult) | undefined,
  rebind: (cfg: OpenClawConfig) => OpenClawConfig,
  fallback?: NonNullable<TResult>,
): typeof callback {
  return callback
    ? (((cfg: OpenClawConfig, ...args: TArgs) =>
        callback(rebind(cfg), ...args) ?? fallback) as typeof callback)
    : undefined;
}

function rebindLastConfig<TAccount, TResult>(
  callback: ((account: TAccount, cfg: OpenClawConfig) => TResult) | undefined,
  rebind: (cfg: OpenClawConfig) => OpenClawConfig,
  fallback?: NonNullable<TResult>,
): typeof callback {
  return callback
    ? (((account: TAccount, cfg: OpenClawConfig) =>
        callback(account, rebind(cfg)) ?? fallback) as typeof callback)
    : undefined;
}

function rebindConfigParam<TParams extends { cfg: OpenClawConfig }, TResult>(
  callback: ((params: TParams) => TResult) | undefined,
  rebind: (cfg: OpenClawConfig) => OpenClawConfig,
  fallback?: NonNullable<TResult>,
): typeof callback {
  return callback
    ? (((params: TParams) =>
        callback({ ...params, cfg: rebind(params.cfg) }) ?? fallback) as typeof callback)
    : undefined;
}

function rebindChannelPluginConfig(
  config: ChannelPlugin["config"],
  sourceChannelId: string,
  targetChannelId: string,
): ChannelPlugin["config"] {
  const rebind = (cfg: OpenClawConfig) =>
    rebindChannelConfig(cfg, sourceChannelId, targetChannelId);
  const mutation = <TParams extends { cfg: OpenClawConfig }>(
    callback: ((params: TParams) => OpenClawConfig) | undefined,
  ): typeof callback =>
    callback
      ? (((params: TParams) =>
          restoreReboundChannelConfig({
            original: params.cfg,
            updated: callback({ ...params, cfg: rebind(params.cfg) }) ?? params.cfg,
            sourceChannelId,
            targetChannelId,
          })) as typeof callback)
      : undefined;
  return {
    ...config,
    listAccountIds: rebindFirstConfig(config.listAccountIds, rebind)!,
    resolveAccount: rebindFirstConfig(config.resolveAccount, rebind)!,
    inspectAccount: rebindFirstConfig(config.inspectAccount, rebind),
    defaultAccountId: rebindFirstConfig(config.defaultAccountId, rebind, ""),
    setAccountEnabled: mutation(config.setAccountEnabled),
    deleteAccount: mutation(config.deleteAccount),
    isEnabled: rebindLastConfig(config.isEnabled, rebind, false),
    disabledReason: rebindLastConfig(config.disabledReason, rebind, ""),
    isConfigured: rebindLastConfig(config.isConfigured, rebind, false),
    isLinked: rebindLastConfig(config.isLinked, rebind, "unknown"),
    unconfiguredReason: rebindLastConfig(config.unconfiguredReason, rebind, ""),
    unlinkedReason: rebindLastConfig(config.unlinkedReason, rebind, ""),
    describeAccount: rebindLastConfig(config.describeAccount, rebind),
    resolveAllowFrom: rebindConfigParam(config.resolveAllowFrom, rebind),
    formatAllowFrom: rebindConfigParam(config.formatAllowFrom, rebind, []),
    hasConfiguredState: rebindConfigParam(config.hasConfiguredState, rebind, false),
    hasPersistedAuthState: rebindConfigParam(config.hasPersistedAuthState, rebind, false),
    resolveDefaultTo: rebindConfigParam(config.resolveDefaultTo, rebind),
  };
}

function rebindChannelScopedString(value: string, sourceId: string, targetId: string): string {
  const sourcePrefix = `channels.${sourceId}`;
  return value === sourcePrefix
    ? `channels.${targetId}`
    : value.startsWith(`${sourcePrefix}.`)
      ? `channels.${targetId}${value.slice(sourcePrefix.length)}`
      : value;
}

function rebindChannelPluginSecrets(
  secrets: ChannelPlugin["secrets"],
  sourceChannelId: string,
  targetChannelId: string,
): ChannelPlugin["secrets"] {
  if (!secrets) {
    return undefined;
  }
  const rebindString = (value: string) =>
    rebindChannelScopedString(value, sourceChannelId, targetChannelId);
  return {
    ...secrets,
    secretTargetRegistryEntries: secrets.secretTargetRegistryEntries?.map((entry) => ({
      ...entry,
      id: rebindString(entry.id),
      pathPattern: rebindString(entry.pathPattern),
      ...(entry.refPathPattern ? { refPathPattern: rebindString(entry.refPathPattern) } : {}),
    })),
    unsupportedSecretRefSurfacePatterns:
      secrets.unsupportedSecretRefSurfacePatterns?.map(rebindString),
    collectRuntimeConfigAssignments: secrets.collectRuntimeConfigAssignments
      ? (params) =>
          secrets.collectRuntimeConfigAssignments?.({
            ...params,
            config: rebindChannelConfig(params.config, sourceChannelId, targetChannelId),
          })
      : undefined,
  };
}

function cloneChannelPluginForChannelId(plugin: ChannelPlugin, channelId: string): ChannelPlugin {
  if (plugin.id === channelId && plugin.meta.id === channelId) {
    return plugin;
  }
  return {
    ...plugin,
    id: channelId,
    meta: { ...plugin.meta, id: channelId },
    config: rebindChannelPluginConfig(plugin.config, plugin.id, channelId),
    secrets: rebindChannelPluginSecrets(plugin.secrets, plugin.id, channelId),
  };
}

function loadExternalSetupChannelPlugin(params: {
  record: PluginManifestRecord;
  channelId: string;
}): { plugin?: ChannelPlugin; failure?: ReadOnlyChannelPluginLoadFailure } {
  const { record, channelId } = params;
  if (!record.setupSource || !record.channels.includes(channelId)) {
    return {};
  }
  try {
    const artifactBasename = path
      .relative(record.rootDir, record.setupSource)
      .replaceAll(path.sep, "/");
    const registration = resolveSetupChannelRegistration(
      loadPluginPublicArtifactModuleSync({ pluginRoot: record.rootDir, artifactBasename }),
    );
    if (registration.loadError) {
      throw new Error(formatErrorMessage(registration.loadError), {
        cause: registration.loadError,
      });
    }
    if (
      !registration.plugin ||
      !channelPluginIdBelongsToManifest({
        channelId: registration.plugin.id,
        pluginId: record.id,
        manifestChannels: record.channels,
      })
    ) {
      return {};
    }
    return { plugin: cloneChannelPluginForChannelId(registration.plugin, channelId) };
  } catch (error) {
    return {
      failure: {
        channelId,
        pluginId: record.id,
        source: record.setupSource,
        message: `failed to load setup entry: ${formatErrorMessage(error)}`,
      },
    };
  }
}

function resolveConfiguredChannelIds(params: {
  cfg: OpenClawConfig;
  activationSourceConfig: OpenClawConfig;
  workspaceDir?: string;
  env: NodeJS.ProcessEnv;
  includePersistedAuthState?: boolean;
  manifestRecords: readonly PluginManifestRecord[];
}): string[] {
  const shared = {
    activationSourceConfig: params.activationSourceConfig,
    workspaceDir: params.workspaceDir,
    env: params.env,
    includePersistedAuthState: params.includePersistedAuthState,
    manifestRecords: params.manifestRecords,
  };
  return uniqueStrings([
    ...listConfiguredChannelIdsForReadOnlyScope({ config: params.cfg, ...shared }),
    ...(params.activationSourceConfig === params.cfg
      ? []
      : listConfiguredChannelIdsForReadOnlyScope({
          config: params.activationSourceConfig,
          ...shared,
        })),
  ]).filter(isSafeManifestChannelId);
}

function resolveReadOnlyWorkspaceDir(
  cfg: OpenClawConfig,
  options: ReadOnlyChannelPluginOptions,
): string | undefined {
  return options.workspaceDir ?? resolveAgentWorkspaceDir(cfg, resolveDefaultAgentId(cfg));
}

export function listReadOnlyChannelPluginsForConfig(
  cfg: OpenClawConfig,
  options?: ReadOnlyChannelPluginOptions,
): ChannelPlugin[] {
  return resolveReadOnlyChannelPluginsForConfig(cfg, options).plugins;
}

export function resolveReadOnlyChannelPluginsForConfig(
  cfg: OpenClawConfig,
  options: ReadOnlyChannelPluginOptions = {},
): ReadOnlyChannelPluginResolution {
  const env = options.env ?? process.env;
  const workspaceDir = resolveReadOnlyWorkspaceDir(cfg, options);
  const snapshot = resolvePluginMetadataSnapshot({
    config: cfg,
    stateDir: options.stateDir,
    workspaceDir,
    env,
    allowWorkspaceScopedCurrent: true,
  });
  const activationSourceConfig = options.activationSourceConfig ?? cfg;
  const configuredChannelIds = resolveConfiguredChannelIds({
    cfg,
    activationSourceConfig,
    workspaceDir,
    env,
    includePersistedAuthState: options.includePersistedAuthState,
    manifestRecords: snapshot.plugins,
  });
  const byId = new Map(listChannelPlugins().map((plugin) => [plugin.id, plugin]));
  const loadFailures: ReadOnlyChannelPluginLoadFailure[] = [];
  const externalPluginIds = new Set(
    resolveDiscoverableScopedChannelPluginIds({
      config: cfg,
      activationSourceConfig,
      channelIds: configuredChannelIds,
      workspaceDir,
      env,
      manifestRecords: snapshot.plugins.filter((record) => record.origin !== "bundled"),
    }),
  );

  for (const channelId of configuredChannelIds) {
    if (byId.has(channelId)) {
      continue;
    }
    const owners = (snapshot.owners.channels.get(channelId) ?? [])
      .map((pluginId) => snapshot.byPluginId.get(pluginId))
      .filter((record): record is PluginManifestRecord => Boolean(record));
    const bundledOwner = owners.find((record) => record.origin === "bundled");
    if (bundledOwner) {
      const setupPlugin =
        options.includeSetupFallbackPlugins === true
          ? getBundledChannelSetupPlugin(channelId, env)
          : undefined;
      const plugin =
        setupPlugin &&
        channelPluginIdBelongsToManifest({
          channelId: setupPlugin.id,
          pluginId: bundledOwner.id,
          manifestChannels: bundledOwner.channels,
        })
          ? cloneChannelPluginForChannelId(setupPlugin, channelId)
          : canUseManifestChannelPlugin(bundledOwner, channelId)
            ? buildManifestChannelPlugin(bundledOwner, channelId)
            : undefined;
      if (plugin) {
        byId.set(channelId, plugin);
        continue;
      }
    }

    for (const record of owners) {
      if (record.origin === "bundled" || !externalPluginIds.has(record.id)) {
        continue;
      }
      if (options.includeSetupFallbackPlugins === true) {
        const setup = loadExternalSetupChannelPlugin({ record, channelId });
        if (setup.failure) {
          loadFailures.push(setup.failure);
        }
        if (setup.plugin) {
          byId.set(channelId, setup.plugin);
          break;
        }
      }
      if (canUseManifestChannelPlugin(record, channelId)) {
        const plugin = buildManifestChannelPlugin(record, channelId);
        if (plugin) {
          byId.set(channelId, plugin);
          break;
        }
      }
    }
  }

  return {
    plugins: [...byId.values()],
    configuredChannelIds,
    missingConfiguredChannelIds: configuredChannelIds.filter((channelId) => !byId.has(channelId)),
    loadFailures,
  };
}
