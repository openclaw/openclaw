import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  sortUniqueStrings,
  uniqueStrings,
} from "@openclaw/normalization-core/string-normalization";
import { sanitizeForLog } from "../../../packages/terminal-core/src/ansi.js";
import { tryResolveConfiguredAgentWorkspaceDir } from "../../agents/agent-scope.js";
import { resolveConfigWidePluginManifestRegistry } from "../../config/io.plugin-metadata.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { isBlockedObjectKey } from "../../infra/prototype-keys.js";
import {
  hasExplicitChannelConfig,
  listConfiguredChannelIdsForReadOnlyScope,
  listConfiguredChannelIdsForReadOnlyScopeAsync,
  resolveDiscoverableScopedChannelPluginIds,
} from "../../plugins/channel-plugin-ids.js";
import { isInstalledPluginEnabled } from "../../plugins/installed-plugin-index.js";
import type { PluginManifestRecord } from "../../plugins/manifest-registry.js";
import { normalizeManifestChannelCommandDefaults } from "../../plugins/manifest-setup-normalizers.js";
import { getPluginCache } from "../../plugins/plugin-cache.js";
import { resolvePluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.js";
import type { PluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.types.js";
import { resolveNormalizedAccountEntry } from "../../routing/account-lookup.js";
import {
  DEFAULT_ACCOUNT_ID,
  normalizeAccountId,
  normalizeOptionalAccountId,
} from "../../routing/session-key.js";
import { resolveListedDefaultAccountId } from "./account-helpers.js";
import { getBundledChannelSetupPlugin } from "./bundled.js";
import type { ManifestChannelPlugin } from "./manifest-channel-plugin.types.js";
import type { ChannelMessageActionName } from "./message-action-names.js";
import {
  isSafeManifestChannelId,
  readOwnRecordValue,
  resolveReadOnlyChannelCommandDefaults,
} from "./read-only-command-defaults.js";
import { listChannelPlugins } from "./registry.js";
import {
  loadSetupChannelPluginFromManifestRecord,
  type ChannelSetupPluginLoadFailure,
} from "./setup-entry-loader.js";
import type { AnyChannelPlugin as ChannelPlugin } from "./types.plugin.js";

type ReadOnlyChannelPluginOptions = {
  env?: NodeJS.ProcessEnv;
  stateDir?: string;
  workspaceDir?: string;
  activationSourceConfig?: OpenClawConfig;
  includePersistedAuthState?: boolean;
  includeSetupFallbackPlugins?: boolean;
  metadataSnapshot?: PluginMetadataSnapshot;
};

type ReadOnlyChannelPluginResolution = {
  plugins: ChannelPlugin[];
  manifestRecords: readonly PluginManifestRecord[];
  configuredChannelIds: string[];
  missingConfiguredChannelIds: string[];
  loadFailures: ChannelSetupPluginLoadFailure[];
};
type ManifestChannelConfigRecord = NonNullable<PluginManifestRecord["channelConfigs"]>[string];

function addChannelPlugins(
  byId: Map<string, ChannelPlugin>,
  plugins: Iterable<ChannelPlugin | undefined>,
  options?: {
    allowOverwrite?: boolean;
  },
): void {
  for (const plugin of plugins) {
    if (!plugin) {
      continue;
    }
    if (options?.allowOverwrite === false && byId.has(plugin.id)) {
      continue;
    }
    byId.set(plugin.id, plugin);
  }
}

function normalizeManifestText(value: string | undefined, fallback: string): string {
  return sanitizeForLog(value?.trim() || fallback).trim();
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
    channels: {
      ...cfg.channels,
      [sourceChannelId]: cfg.channels[targetChannelId],
    },
  };
}

function getChannelConfigRecord(cfg: OpenClawConfig, channelId: string): Record<string, unknown> {
  if (!isSafeManifestChannelId(channelId)) {
    return {};
  }
  const channels = asOptionalRecord(cfg.channels);
  return (channels && asOptionalRecord(readOwnRecordValue(channels, channelId))) ?? {};
}

function listManifestChannelAccountIds(cfg: OpenClawConfig, channelId: string): string[] {
  const channelConfig = getChannelConfigRecord(cfg, channelId);
  const accounts = channelConfig.accounts;
  if (accounts && typeof accounts === "object" && !Array.isArray(accounts)) {
    return sortUniqueStrings(
      Object.keys(accounts)
        .filter((accountId) => !isBlockedObjectKey(accountId))
        .map((accountId) => normalizeOptionalAccountId(accountId))
        .filter((accountId): accountId is string => Boolean(accountId)),
    );
  }
  return hasExplicitChannelConfig({ config: cfg, channelId }) ? [DEFAULT_ACCOUNT_ID] : [];
}

function resolveManifestChannelDefaultAccountId(cfg: OpenClawConfig, channelId: string): string {
  const channelConfig = getChannelConfigRecord(cfg, channelId);
  const configuredDefaultAccountId = normalizeOptionalAccountId(
    typeof channelConfig.defaultAccount === "string" ? channelConfig.defaultAccount : undefined,
  );
  return resolveListedDefaultAccountId({
    accountIds: listManifestChannelAccountIds(cfg, channelId),
    configuredDefaultAccountId,
  });
}

function buildManifestChannelPlugin(params: {
  record: PluginManifestRecord;
  channelId: string;
}): ChannelPlugin | undefined {
  // Only the adapter is static; its methods receive current account config and
  // channel selection still reevaluates policy, environment, and persisted auth.
  const adapters = getPluginCache().metadata.channelAdapters;
  let channels = adapters.get(params.record);
  if (!channels) {
    channels = new Map();
    adapters.set(params.record, channels);
  }
  if (!channels.has(params.channelId)) {
    channels.set(params.channelId, createManifestChannelPlugin(params));
  }
  return channels.get(params.channelId);
}

function createManifestChannelPlugin(params: {
  record: PluginManifestRecord;
  channelId: string;
}): ManifestChannelPlugin | undefined {
  if (!isSafeManifestChannelId(params.channelId)) {
    return undefined;
  }
  // Package presentation describes one channel, even when the plugin owns several.
  const packageChannel =
    params.record.packageChannel?.id === params.channelId
      ? params.record.packageChannel
      : undefined;
  const catalogMeta =
    params.record.channelCatalogMeta?.id === params.channelId
      ? params.record.channelCatalogMeta
      : undefined;
  const channelConfig = asOptionalRecord(
    params.record.channelConfigs
      ? readOwnRecordValue(
          params.record.channelConfigs as Record<string, unknown>,
          params.channelId,
        )
      : undefined,
  ) as ManifestChannelConfigRecord | undefined;
  if (!catalogMeta && !channelConfig && !params.record.channels.includes(params.channelId)) {
    return undefined;
  }
  const label =
    normalizeManifestText(
      channelConfig?.label ?? catalogMeta?.label,
      params.record.name || params.channelId,
    ) || params.channelId;
  const blurb = normalizeManifestText(
    channelConfig?.description ?? catalogMeta?.blurb,
    params.record.description || "",
  );
  const detailLabel = normalizeManifestText(packageChannel?.detailLabel, "");
  const systemImage = normalizeManifestText(packageChannel?.systemImage, "");
  const commands = normalizeManifestChannelCommandDefaults(
    channelConfig?.commands ?? catalogMeta?.commands,
  );
  return {
    id: params.channelId,
    meta: {
      id: params.channelId,
      label,
      selectionLabel: normalizeManifestText(packageChannel?.selectionLabel, label) || label,
      ...(detailLabel ? { detailLabel } : {}),
      ...(systemImage ? { systemImage } : {}),
      docsPath: `/channels/${encodeURIComponent(params.channelId)}`,
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
      listAccountIds: (cfg) => listManifestChannelAccountIds(cfg, params.channelId),
      defaultAccountId: (cfg) => resolveManifestChannelDefaultAccountId(cfg, params.channelId),
      resolveAccount: (cfg, rawAccountId) => {
        const channelId = params.channelId;
        const accountKeyPolicy = params.record.channelAccountKeyPolicies?.[params.channelId];
        const accountChannelConfig = getChannelConfigRecord(cfg, channelId);
        const accountId = normalizeAccountId(rawAccountId);
        const accounts = asOptionalRecord(accountChannelConfig.accounts);
        const config =
          asOptionalRecord(
            accounts
              ? resolveNormalizedAccountEntry(
                  accounts,
                  accountId,
                  (candidateId) => normalizeOptionalAccountId(candidateId) ?? "",
                  accountKeyPolicy,
                )
              : undefined,
          ) ?? accountChannelConfig;
        return {
          accountId,
          name: normalizeOptionalString(readOwnRecordValue(config, "name")),
          config,
        };
      },
      isEnabled: (account, cfg) =>
        getChannelConfigRecord(cfg, params.channelId).enabled !== false &&
        account.config.enabled !== false,
      isConfigured: (_account, cfg) =>
        hasExplicitChannelConfig({
          config: cfg,
          channelId: params.channelId,
        }),
      hasConfiguredState: ({ cfg }) =>
        hasExplicitChannelConfig({
          config: cfg,
          channelId: params.channelId,
        }),
    },
  };
}

function canUseManifestChannelPlugin(record: PluginManifestRecord, channelId: string): boolean {
  const hasChannelConfig = Boolean(
    record.channelConfigs && Object.hasOwn(record.channelConfigs, channelId),
  );
  if (hasChannelConfig) {
    return record.setup?.requiresRuntime === false || !record.setupSource;
  }
  return record.channelCatalogMeta?.id === channelId || !record.setupSource;
}

export { resolveReadOnlyChannelCommandDefaults };

function rebindChannelPluginConfig(
  config: ChannelPlugin["config"],
  sourceChannelId: string,
  targetChannelId: string,
): ChannelPlugin["config"] {
  const rebind = (cfg: OpenClawConfig) =>
    rebindChannelConfig(cfg, sourceChannelId, targetChannelId);
  function withConfig<Args extends unknown[], Result>(
    method: (cfg: OpenClawConfig, ...args: Args) => Result,
  ): (cfg: OpenClawConfig, ...args: Args) => Result;
  function withConfig<Args extends unknown[], Result>(
    method: ((cfg: OpenClawConfig, ...args: Args) => Result) | undefined,
  ): ((cfg: OpenClawConfig, ...args: Args) => Result) | undefined;
  function withConfig<Args extends unknown[], Result>(
    method: ((cfg: OpenClawConfig, ...args: Args) => Result) | undefined,
  ) {
    return (
      method && ((cfg: OpenClawConfig, ...args: Args) => method.call(config, rebind(cfg), ...args))
    );
  }
  const withAccount = <Account, Result>(
    method: ((account: Account, cfg: OpenClawConfig) => Result) | undefined,
  ) =>
    method &&
    ((account: Account, cfg: OpenClawConfig) => method.call(config, account, rebind(cfg)));
  const withParams = <Params extends { cfg: OpenClawConfig }, Result>(
    method: ((params: Params) => Result) | undefined,
  ) => method && ((params: Params) => method.call(config, { ...params, cfg: rebind(params.cfg) }));
  const rebindWriter = <Params extends { cfg: OpenClawConfig }>(
    method: ((params: Params) => OpenClawConfig) | undefined,
  ) =>
    method
      ? (params: Params) => {
          const original = params.cfg;
          const updated = method.call(config, { ...params, cfg: rebind(params.cfg) });
          if (sourceChannelId === targetChannelId || !updated.channels) {
            return updated;
          }
          const nextChannels = { ...updated.channels };
          if (Object.hasOwn(nextChannels, sourceChannelId)) {
            nextChannels[targetChannelId] = nextChannels[sourceChannelId];
          } else {
            delete nextChannels[targetChannelId];
          }
          if (original.channels && Object.hasOwn(original.channels, sourceChannelId)) {
            nextChannels[sourceChannelId] = original.channels[sourceChannelId];
          } else {
            delete nextChannels[sourceChannelId];
          }
          return {
            ...updated,
            channels: nextChannels,
          };
        }
      : undefined;
  return {
    ...config,
    listAccountIds: withConfig(config.listAccountIds),
    resolveAccount: withConfig(config.resolveAccount),
    resolveAccountAsync: withConfig(config.resolveAccountAsync),
    inspectAccount: withConfig(config.inspectAccount),
    defaultAccountId: withConfig(config.defaultAccountId),
    setAccountEnabled: rebindWriter(config.setAccountEnabled),
    deleteAccount: rebindWriter(config.deleteAccount),
    isEnabled: withAccount(config.isEnabled),
    disabledReason: withAccount(config.disabledReason),
    isConfigured: withAccount(config.isConfigured),
    isLinked: withAccount(config.isLinked),
    unconfiguredReason: withAccount(config.unconfiguredReason),
    unlinkedReason: withAccount(config.unlinkedReason),
    describeAccount: withAccount(config.describeAccount),
    describeAccountAsync: withAccount(config.describeAccountAsync),
    resolveAllowFrom: withParams(config.resolveAllowFrom),
    resolveAllowFromAsync: withParams(config.resolveAllowFromAsync),
    formatAllowFrom: withParams(config.formatAllowFrom),
    hasConfiguredState: withParams(config.hasConfiguredState),
    hasConfiguredStateAsync: withParams(config.hasConfiguredStateAsync),
    hasPersistedAuthState: withParams(config.hasPersistedAuthState),
    resolveDefaultTo: withParams(config.resolveDefaultTo),
  };
}

function rebindChannelPluginSecrets(
  secrets: ChannelPlugin["secrets"],
  sourceChannelId: string,
  targetChannelId: string,
): ChannelPlugin["secrets"] {
  if (!secrets) {
    return undefined;
  }
  const sourcePrefix = `channels.${sourceChannelId}`;
  const rebind = (value: string) =>
    value === sourcePrefix || value.startsWith(`${sourcePrefix}.`)
      ? `channels.${targetChannelId}${value.slice(sourcePrefix.length)}`
      : value;
  return {
    ...secrets,
    secretTargetRegistryEntries: secrets.secretTargetRegistryEntries?.map((entry) => ({
      ...entry,
      id: rebind(entry.id),
      pathPattern: rebind(entry.pathPattern),
      ...(entry.refPathPattern ? { refPathPattern: rebind(entry.refPathPattern) } : {}),
    })),
    unsupportedSecretRefSurfacePatterns: secrets.unsupportedSecretRefSurfacePatterns?.map(rebind),
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

function addManifestChannelPlugins(
  byId: Map<string, ChannelPlugin>,
  records: readonly PluginManifestRecord[],
  options: {
    pluginIds: ReadonlySet<string>;
    channelIds: readonly string[];
    includeSetupFallbackPlugins: boolean;
  },
): void {
  const channelIds = new Set(options.channelIds);
  for (const record of records) {
    if (!options.pluginIds.has(record.id)) {
      continue;
    }
    for (const channelId of record.channels) {
      if (!isSafeManifestChannelId(channelId)) {
        continue;
      }
      if (!channelIds.has(channelId)) {
        continue;
      }
      // Inventory can describe accounts without executing setup. Setup-backed callers
      // must still see missing capabilities when a runtime-dependent setup fails.
      if (options.includeSetupFallbackPlugins && !canUseManifestChannelPlugin(record, channelId)) {
        continue;
      }
      addChannelPlugins(byId, [buildManifestChannelPlugin({ record, channelId })], {
        allowOverwrite: false,
      });
    }
  }
}

/**
 * Builds a runtime-free channel adapter for a manifest-declared Gateway-owned message
 * action. The Gateway's loaded plugin executes it; this process only routes the request.
 */
export function resolveGatewayDelegatedChannelPlugin(params: {
  channelId: string;
  action: ChannelMessageActionName;
  config: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): ChannelPlugin | undefined {
  if (!isSafeManifestChannelId(params.channelId)) {
    return undefined;
  }
  const snapshot = resolvePluginMetadataSnapshot({
    config: params.config,
    env: params.env ?? process.env,
    allowWorkspaceScopedCurrent: true,
  });
  for (const record of snapshot.plugins) {
    if (
      !record.channels.includes(params.channelId) ||
      !isInstalledPluginEnabled(snapshot.index, record.id, params.config)
    ) {
      continue;
    }
    const channelConfig = asOptionalRecord(
      record.channelConfigs
        ? readOwnRecordValue(record.channelConfigs as Record<string, unknown>, params.channelId)
        : undefined,
    ) as ManifestChannelConfigRecord | undefined;
    const gatewayActions = new Set(channelConfig?.gatewayMessageActions);
    const plugin = gatewayActions.has(params.action)
      ? buildManifestChannelPlugin({ record, channelId: params.channelId })
      : undefined;
    if (!plugin) {
      continue;
    }
    return {
      ...plugin,
      // Gateway delivery marks the adapter as a selected sender, so outbound
      // resolution does not bootstrap the channel runtime this adapter replaces.
      outbound: { deliveryMode: "gateway" },
      actions: {
        describeMessageTool: () => ({ actions: [...gatewayActions] }),
        supportsAction: ({ action }) => gatewayActions.has(action),
        resolveExecutionMode: () => "gateway",
        handleAction: async () => {
          throw new Error(
            `Channel ${params.channelId} action ${params.action} requires its plugin in the Gateway.`,
          );
        },
      },
    };
  }
  return undefined;
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
  const context = resolveReadOnlyChannelContext(cfg, options);
  const configuredChannelIds = listReadOnlyChannelConfiguredIds(cfg, options, context);
  return resolveReadOnlyChannelPluginsFromIds(cfg, options, context, configuredChannelIds);
}

export async function listReadOnlyChannelPluginsForConfigAsync(
  cfg: OpenClawConfig,
  options: ReadOnlyChannelPluginOptions = {},
): Promise<ChannelPlugin[]> {
  const context = resolveReadOnlyChannelContext(cfg, options);
  const loadedChannelPlugins = listChannelPlugins();
  const loadedChannelIds = new Set(loadedChannelPlugins.map((plugin) => plugin.id));
  // Registered channels are already included; saved auth cannot add them to this inventory.
  const discoveryRecords = context.manifestRecords.filter((record) =>
    record.channels.some((channelId) => !loadedChannelIds.has(channelId)),
  );
  const listConfiguredIds = (config: OpenClawConfig) =>
    listConfiguredChannelIdsForReadOnlyScopeAsync({
      config,
      ...context,
      manifestRecords: discoveryRecords,
      includePersistedAuthState: options.includePersistedAuthState,
    });
  const configuredChannelIds = uniqueStrings([
    ...(await listConfiguredIds(cfg)),
    ...(context.activationSourceConfig === cfg
      ? []
      : await listConfiguredIds(context.activationSourceConfig)),
  ]).filter(isSafeManifestChannelId);
  return resolveReadOnlyChannelPluginsFromIds(
    cfg,
    options,
    context,
    configuredChannelIds,
    loadedChannelPlugins,
  ).plugins;
}

function resolveReadOnlyChannelContext(cfg: OpenClawConfig, options: ReadOnlyChannelPluginOptions) {
  const env = options.env ?? process.env;
  const workspaceDir =
    options.workspaceDir ?? tryResolveConfiguredAgentWorkspaceDir(cfg, options.env);
  const manifestRecords =
    options.metadataSnapshot?.plugins ??
    (options.workspaceDir !== undefined
      ? resolvePluginMetadataSnapshot({
          config: cfg,
          stateDir: options.stateDir,
          workspaceDir: options.workspaceDir,
          env,
          allowWorkspaceScopedCurrent: true,
        }).plugins
      : resolveConfigWidePluginManifestRegistry({
          config: cfg,
          stateDir: options.stateDir,
          env,
        }).plugins);
  const activationSourceConfig = options.activationSourceConfig ?? cfg;
  return { env, workspaceDir, manifestRecords, activationSourceConfig };
}

function listReadOnlyChannelConfiguredIds(
  cfg: OpenClawConfig,
  options: ReadOnlyChannelPluginOptions,
  context: ReturnType<typeof resolveReadOnlyChannelContext>,
) {
  const { activationSourceConfig, workspaceDir, env, manifestRecords } = context;
  const listConfiguredIds = (config: OpenClawConfig) =>
    listConfiguredChannelIdsForReadOnlyScope({
      config,
      activationSourceConfig,
      workspaceDir,
      env,
      includePersistedAuthState: options.includePersistedAuthState,
      manifestRecords,
    });
  return uniqueStrings([
    ...listConfiguredIds(cfg),
    ...(activationSourceConfig === cfg ? [] : listConfiguredIds(activationSourceConfig)),
  ]).filter(isSafeManifestChannelId);
}

function resolveReadOnlyChannelPluginsFromIds(
  cfg: OpenClawConfig,
  options: ReadOnlyChannelPluginOptions,
  context: ReturnType<typeof resolveReadOnlyChannelContext>,
  configuredChannelIds: string[],
  loadedChannelPlugins = listChannelPlugins(),
): ReadOnlyChannelPluginResolution {
  const { activationSourceConfig, workspaceDir, env, manifestRecords } = context;
  const includeSetupFallbackPlugins = options.includeSetupFallbackPlugins === true;
  const bundledManifestRecords = manifestRecords.filter(
    (plugin) => plugin.origin === "bundled" && plugin.channels.length > 0,
  );
  const externalManifestRecords = manifestRecords.filter(
    (plugin) => plugin.origin !== "bundled" && plugin.channels.length > 0,
  );
  const byId = new Map<string, ChannelPlugin>();
  const loadFailures: ChannelSetupPluginLoadFailure[] = [];

  addChannelPlugins(byId, loadedChannelPlugins);

  if (includeSetupFallbackPlugins) {
    for (const channelId of configuredChannelIds) {
      if (byId.has(channelId)) {
        continue;
      }
      const setupResults = bundledManifestRecords
        .filter((record) => record.channels.includes(channelId))
        .map((record) =>
          loadSetupChannelPluginFromManifestRecord({
            record,
            channelId,
            env,
          }),
        );
      loadFailures.push(
        ...setupResults
          .map((result) => result.failure)
          .filter((failure): failure is ChannelSetupPluginLoadFailure => Boolean(failure)),
      );
      const bundledSetupPlugin =
        setupResults.map((result) => result.plugin).find((plugin) => plugin) ??
        getBundledChannelSetupPlugin(channelId, env);
      addChannelPlugins(byId, [
        bundledSetupPlugin && cloneChannelPluginForChannelId(bundledSetupPlugin, channelId),
      ]);
    }
  }

  const bundledManifestMissingChannelIds = configuredChannelIds.filter(
    (channelId) => !byId.has(channelId),
  );
  addManifestChannelPlugins(byId, bundledManifestRecords, {
    pluginIds: new Set(bundledManifestRecords.map((record) => record.id)),
    channelIds: bundledManifestMissingChannelIds,
    includeSetupFallbackPlugins,
  });

  const missingConfiguredChannelIds = configuredChannelIds.filter(
    (channelId) => !byId.has(channelId),
  );
  let externalPluginIds: string[] = [];
  if (missingConfiguredChannelIds.length > 0) {
    const candidatePluginIds = resolveDiscoverableScopedChannelPluginIds({
      config: cfg,
      activationSourceConfig,
      channelIds: missingConfiguredChannelIds,
      workspaceDir,
      env,
      manifestRecords: externalManifestRecords,
    });
    if (candidatePluginIds.length > 0) {
      const requestedChannelIds = new Set(missingConfiguredChannelIds);
      const candidatePluginIdSet = new Set(candidatePluginIds);
      externalPluginIds = externalManifestRecords
        .filter(
          (plugin) =>
            candidatePluginIdSet.has(plugin.id) &&
            plugin.channels.some((channelId) => requestedChannelIds.has(channelId)),
        )
        .map((plugin) => plugin.id)
        .toSorted((left, right) => left.localeCompare(right));
    }
  }
  if (externalPluginIds.length > 0) {
    const externalPluginIdSet = new Set(externalPluginIds);
    if (includeSetupFallbackPlugins) {
      const missingChannelIdSet = new Set(missingConfiguredChannelIds);
      for (const record of externalManifestRecords) {
        if (!externalPluginIdSet.has(record.id) || !record.setupSource) {
          continue;
        }
        const ownedMissingChannelIds = record.channels.filter(
          (channelId) => missingChannelIdSet.has(channelId) && !byId.has(channelId),
        );
        const firstChannelId = ownedMissingChannelIds[0];
        if (!firstChannelId) {
          continue;
        }
        const setupResult = loadSetupChannelPluginFromManifestRecord({
          record,
          channelId: firstChannelId,
          env,
        });
        const failure = setupResult.failure;
        if (failure) {
          loadFailures.push(
            ...ownedMissingChannelIds.map((channelId) => ({ ...failure, channelId })),
          );
          continue;
        }
        const plugin = setupResult.plugin;
        if (plugin) {
          addChannelPlugins(
            byId,
            ownedMissingChannelIds.map((channelId) =>
              cloneChannelPluginForChannelId(plugin, channelId),
            ),
            { allowOverwrite: false },
          );
        }
      }
    }
    const externalManifestMissingChannelIds = missingConfiguredChannelIds.filter(
      (channelId) => !byId.has(channelId),
    );
    addManifestChannelPlugins(byId, externalManifestRecords, {
      pluginIds: externalPluginIdSet,
      channelIds: externalManifestMissingChannelIds,
      includeSetupFallbackPlugins,
    });
  }

  const plugins = [...byId.values()];
  return {
    plugins,
    manifestRecords: [...manifestRecords],
    configuredChannelIds,
    missingConfiguredChannelIds: configuredChannelIds.filter((channelId) => !byId.has(channelId)),
    loadFailures,
  };
}
