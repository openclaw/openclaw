import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import { collectConfiguredAgentHarnessRuntimes } from "../agents/harness-runtimes.js";
import {
  hasMeaningfulChannelConfig,
  listPotentialConfiguredChannelIds,
} from "../channels/config-presence.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  resolveMemoryDreamingConfig,
  resolveMemoryDreamingPluginConfig,
  resolveMemoryDreamingPluginId,
} from "../memory-host-sdk/dreaming.js";
import { isSafeChannelEnvVarTriggerName } from "../secrets/channel-env-var-names.js";
import { normalizeOptionalLowercaseString } from "../shared/string-coerce.js";
import { resolveManifestActivationPluginIds } from "./activation-planner.js";
import {
  createPluginActivationSource,
  normalizePluginId,
  normalizePluginsConfig,
  resolveEffectivePluginActivationState,
} from "./config-state.js";
import {
  hasExplicitManifestOwnerTrust,
  isActivatedManifestOwner,
  isBundledManifestOwner,
  passesManifestOwnerBasePolicy,
} from "./manifest-owner-policy.js";
import { loadPluginManifestRegistry, type PluginManifestRecord } from "./manifest-registry.js";
import { hasKind } from "./slots.js";

function hasRuntimeContractSurface(plugin: PluginManifestRecord): boolean {
  return Boolean(
    plugin.providers.length > 0 ||
    plugin.cliBackends.length > 0 ||
    plugin.contracts?.speechProviders?.length ||
    plugin.contracts?.mediaUnderstandingProviders?.length ||
    plugin.contracts?.imageGenerationProviders?.length ||
    plugin.contracts?.videoGenerationProviders?.length ||
    plugin.contracts?.musicGenerationProviders?.length ||
    plugin.contracts?.webFetchProviders?.length ||
    plugin.contracts?.webSearchProviders?.length ||
    plugin.contracts?.memoryEmbeddingProviders?.length ||
    hasKind(plugin.kind, "memory"),
  );
}

function isGatewayStartupMemoryPlugin(plugin: PluginManifestRecord): boolean {
  return hasKind(plugin.kind, "memory");
}

function isGatewayStartupSidecar(plugin: PluginManifestRecord): boolean {
  return plugin.channels.length === 0 && !hasRuntimeContractSurface(plugin);
}

function dedupeSortedPluginIds(values: Iterable<string>): string[] {
  return [...new Set(values)].toSorted((left, right) => left.localeCompare(right));
}

function normalizeChannelIds(channelIds: Iterable<string>): string[] {
  return Array.from(
    new Set(
      [...channelIds]
        .map((channelId) => normalizeOptionalLowercaseString(channelId))
        .filter((channelId): channelId is string => Boolean(channelId)),
    ),
  ).toSorted((left, right) => left.localeCompare(right));
}

const IGNORED_CHANNEL_CONFIG_KEYS = new Set(["defaults", "modelByChannel"]);

function hasNonEmptyEnvValue(env: NodeJS.ProcessEnv, key: string): boolean {
  if (!isSafeChannelEnvVarTriggerName(key)) {
    return false;
  }
  const trimmed = key.trim();
  const value = env[trimmed] ?? env[trimmed.toUpperCase()];
  return typeof value === "string" && value.trim().length > 0;
}

function listEnvConfiguredManifestChannelIds(params: {
  records: readonly PluginManifestRecord[];
  config: OpenClawConfig;
  activationSourceConfig?: OpenClawConfig;
  env: NodeJS.ProcessEnv;
}): string[] {
  const channelIds = new Set<string>();
  const trustConfig = params.activationSourceConfig ?? params.config;
  const normalizedConfig = normalizePluginsConfig(trustConfig.plugins);
  for (const record of params.records) {
    if (
      !isChannelPluginEligibleForScopedOwnership({
        plugin: record,
        normalizedConfig,
        rootConfig: trustConfig,
      })
    ) {
      continue;
    }
    for (const channelId of record.channels) {
      const envVars = record.channelEnvVars?.[channelId] ?? [];
      if (envVars.some((envVar) => hasNonEmptyEnvValue(params.env, envVar))) {
        channelIds.add(channelId);
      }
    }
  }
  return [...channelIds].toSorted((left, right) => left.localeCompare(right));
}

export function hasExplicitChannelConfig(params: {
  config: OpenClawConfig;
  channelId: string;
}): boolean {
  const channels = params.config.channels;
  if (!channels || typeof channels !== "object" || Array.isArray(channels)) {
    return false;
  }
  const entry = (channels as Record<string, unknown>)[params.channelId];
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return false;
  }
  return (entry as { enabled?: unknown }).enabled === true || hasMeaningfulChannelConfig(entry);
}

export function listExplicitConfiguredChannelIdsForConfig(config: OpenClawConfig): string[] {
  const channels = config.channels;
  if (!channels || typeof channels !== "object" || Array.isArray(channels)) {
    return [];
  }
  return Object.keys(channels)
    .filter(
      (channelId) =>
        !IGNORED_CHANNEL_CONFIG_KEYS.has(channelId) &&
        hasExplicitChannelConfig({ config, channelId }),
    )
    .toSorted((left, right) => left.localeCompare(right));
}

function recordOwnsChannel(record: PluginManifestRecord, channelId: string): boolean {
  const normalizedChannelId = normalizeOptionalLowercaseString(channelId) ?? "";
  if (!normalizedChannelId) {
    return false;
  }
  return [...record.channels, ...(record.activation?.onChannels ?? [])].some(
    (ownedChannelId) =>
      (normalizeOptionalLowercaseString(ownedChannelId) ?? "") === normalizedChannelId,
  );
}

function isChannelPluginEligibleForEffectiveConfiguredChannel(params: {
  plugin: PluginManifestRecord;
  channelId: string;
  normalizedConfig: ReturnType<typeof normalizePluginsConfig>;
  config: OpenClawConfig;
  activationSource: ReturnType<typeof createPluginActivationSource>;
}): boolean {
  if (
    !passesManifestOwnerBasePolicy({
      plugin: params.plugin,
      normalizedConfig: params.normalizedConfig,
    })
  ) {
    return false;
  }
  if (!isBundledManifestOwner(params.plugin)) {
    if (params.plugin.origin === "global" || params.plugin.origin === "config") {
      return hasExplicitManifestOwnerTrust({
        plugin: params.plugin,
        normalizedConfig: params.normalizedConfig,
      });
    }
    return isActivatedManifestOwner({
      plugin: params.plugin,
      normalizedConfig: params.normalizedConfig,
      rootConfig: params.activationSource.rootConfig,
    });
  }
  if (
    hasExplicitChannelConfig({
      config: params.activationSource.rootConfig ?? params.config,
      channelId: params.channelId,
    })
  ) {
    return true;
  }
  return resolveEffectivePluginActivationState({
    id: params.plugin.id,
    origin: params.plugin.origin,
    config: params.normalizedConfig,
    rootConfig: params.config,
    enabledByDefault: params.plugin.enabledByDefault,
    activationSource: params.activationSource,
  }).enabled;
}

function filterEffectiveConfiguredChannelIds(params: {
  channelIds: Iterable<string>;
  records: readonly PluginManifestRecord[];
  config: OpenClawConfig;
  activationSourceConfig?: OpenClawConfig;
}): string[] {
  const channelIds = normalizeChannelIds(params.channelIds);
  if (channelIds.length === 0) {
    return [];
  }
  const activationSource = createPluginActivationSource({
    config: params.activationSourceConfig ?? params.config,
  });
  const normalizedConfig = activationSource.plugins;
  const effective = new Set<string>();
  for (const channelId of channelIds) {
    if (
      params.records.some(
        (record) =>
          recordOwnsChannel(record, channelId) &&
          isChannelPluginEligibleForEffectiveConfiguredChannel({
            plugin: record,
            channelId,
            normalizedConfig,
            config: params.config,
            activationSource,
          }),
      )
    ) {
      effective.add(channelId);
    }
  }
  return [...effective].toSorted((left, right) => left.localeCompare(right));
}

function listConfiguredChannelIdsForPluginScope(params: {
  config: OpenClawConfig;
  activationSourceConfig?: OpenClawConfig;
  workspaceDir?: string;
  env: NodeJS.ProcessEnv;
  cache?: boolean;
  includePersistedAuthState?: boolean;
  manifestRecords?: readonly PluginManifestRecord[];
}): string[] {
  const records =
    params.manifestRecords ??
    loadPluginManifestRegistry({
      config: params.config,
      workspaceDir: params.workspaceDir,
      env: params.env,
      cache: params.cache,
    }).plugins;
  const channelIds = [
    ...new Set([
      ...listPotentialConfiguredChannelIds(params.config, params.env, {
        includePersistedAuthState: params.includePersistedAuthState,
      }),
      ...listEnvConfiguredManifestChannelIds({
        records,
        config: params.config,
        activationSourceConfig: params.activationSourceConfig,
        env: params.env,
      }),
    ]),
  ];
  return filterEffectiveConfiguredChannelIds({
    channelIds,
    records,
    config: params.config,
    activationSourceConfig: params.activationSourceConfig,
  });
}

export function listConfiguredChannelIdsForReadOnlyScope(params: {
  config: OpenClawConfig;
  activationSourceConfig?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  cache?: boolean;
  includePersistedAuthState?: boolean;
  manifestRecords?: readonly PluginManifestRecord[];
}): string[] {
  const env = params.env ?? process.env;
  const workspaceDir =
    params.workspaceDir ??
    resolveAgentWorkspaceDir(params.config, resolveDefaultAgentId(params.config));
  return listConfiguredChannelIdsForPluginScope({
    config: params.config,
    activationSourceConfig: params.activationSourceConfig,
    workspaceDir,
    env,
    cache: params.cache,
    includePersistedAuthState: params.includePersistedAuthState,
    manifestRecords: params.manifestRecords,
  });
}

export function hasConfiguredChannelsForReadOnlyScope(params: {
  config: OpenClawConfig;
  activationSourceConfig?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  cache?: boolean;
  includePersistedAuthState?: boolean;
  manifestRecords?: readonly PluginManifestRecord[];
}): boolean {
  return (
    listConfiguredChannelIdsForReadOnlyScope({
      ...params,
    }).length > 0
  );
}

export function listConfiguredAnnounceChannelIdsForConfig(params: {
  config: OpenClawConfig;
  activationSourceConfig?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  cache?: boolean;
}): string[] {
  const channels = params.config.channels;
  const disabledChannelIds = new Set(
    channels && typeof channels === "object" && !Array.isArray(channels)
      ? Object.entries(channels)
          .filter(([, value]) => {
            return (
              value &&
              typeof value === "object" &&
              !Array.isArray(value) &&
              (value as { enabled?: unknown }).enabled === false
            );
          })
          .map(([channelId]) => channelId)
      : [],
  );
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

function isChannelPluginEligibleForScopedOwnership(params: {
  plugin: PluginManifestRecord;
  normalizedConfig: ReturnType<typeof normalizePluginsConfig>;
  rootConfig: OpenClawConfig;
}): boolean {
  if (
    !passesManifestOwnerBasePolicy({
      plugin: params.plugin,
      normalizedConfig: params.normalizedConfig,
    })
  ) {
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

function resolveScopedChannelOwnerPluginIds(params: {
  config: OpenClawConfig;
  activationSourceConfig?: OpenClawConfig;
  channelIds: readonly string[];
  workspaceDir?: string;
  env: NodeJS.ProcessEnv;
  cache?: boolean;
}): string[] {
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
  const candidateIds = dedupeSortedPluginIds(
    channelIds.flatMap((channelId) => {
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
    }),
  );
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
      });
    })
    .map((plugin) => plugin.id)
    .toSorted((left, right) => left.localeCompare(right));
}

function resolveScopedChannelPluginIds(params: {
  config: OpenClawConfig;
  activationSourceConfig?: OpenClawConfig;
  channelIds: readonly string[];
  workspaceDir?: string;
  env: NodeJS.ProcessEnv;
  cache?: boolean;
}): string[] {
  return resolveScopedChannelOwnerPluginIds(params);
}

export function resolveDiscoverableScopedChannelPluginIds(params: {
  config: OpenClawConfig;
  activationSourceConfig?: OpenClawConfig;
  channelIds: readonly string[];
  workspaceDir?: string;
  env: NodeJS.ProcessEnv;
  cache?: boolean;
}): string[] {
  return resolveScopedChannelOwnerPluginIds(params);
}

function resolveGatewayStartupDreamingPluginIds(config: OpenClawConfig): Set<string> {
  const dreamingConfig = resolveMemoryDreamingConfig({
    pluginConfig: resolveMemoryDreamingPluginConfig(config),
    cfg: config,
  });
  if (!dreamingConfig.enabled) {
    return new Set();
  }
  return new Set(["memory-core", resolveMemoryDreamingPluginId(config)]);
}

function resolveExplicitMemorySlotStartupPluginId(config: OpenClawConfig): string | undefined {
  const configuredSlot = config.plugins?.slots?.memory?.trim();
  if (!configuredSlot || configuredSlot.toLowerCase() === "none") {
    return undefined;
  }
  return normalizePluginId(configuredSlot);
}

function shouldConsiderForGatewayStartup(params: {
  plugin: PluginManifestRecord;
  startupDreamingPluginIds: ReadonlySet<string>;
  explicitMemorySlotStartupPluginId?: string;
}): boolean {
  if (isGatewayStartupSidecar(params.plugin)) {
    return true;
  }
  if (!isGatewayStartupMemoryPlugin(params.plugin)) {
    return false;
  }
  if (params.startupDreamingPluginIds.has(params.plugin.id)) {
    return true;
  }
  return params.explicitMemorySlotStartupPluginId === params.plugin.id;
}

export function resolveChannelPluginIds(params: {
  config: OpenClawConfig;
  workspaceDir?: string;
  env: NodeJS.ProcessEnv;
}): string[] {
  return loadPluginManifestRegistry({
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
  })
    .plugins.filter((plugin) => plugin.channels.length > 0)
    .map((plugin) => plugin.id);
}

export function resolveConfiguredChannelPluginIds(params: {
  config: OpenClawConfig;
  activationSourceConfig?: OpenClawConfig;
  workspaceDir?: string;
  env: NodeJS.ProcessEnv;
}): string[] {
  const configuredChannelIds = new Set(
    listConfiguredChannelIdsForPluginScope({
      config: params.config,
      activationSourceConfig: params.activationSourceConfig,
      workspaceDir: params.workspaceDir,
      env: params.env,
    }).map((id) => id.trim()),
  );
  if (configuredChannelIds.size === 0) {
    return [];
  }
  return resolveScopedChannelPluginIds({
    ...params,
    channelIds: [...configuredChannelIds],
  });
}

export function resolveConfiguredDeferredChannelPluginIds(params: {
  config: OpenClawConfig;
  workspaceDir?: string;
  env: NodeJS.ProcessEnv;
}): string[] {
  const configuredChannelIds = new Set(
    listPotentialConfiguredChannelIds(params.config, params.env).map((id) => id.trim()),
  );
  if (configuredChannelIds.size === 0) {
    return [];
  }
  return loadPluginManifestRegistry({
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
  })
    .plugins.filter(
      (plugin) =>
        plugin.channels.some((channelId) => configuredChannelIds.has(channelId)) &&
        plugin.startupDeferConfiguredChannelFullLoadUntilAfterListen === true,
    )
    .map((plugin) => plugin.id);
}

export function resolveGatewayStartupPluginIds(params: {
  config: OpenClawConfig;
  activationSourceConfig?: OpenClawConfig;
  workspaceDir?: string;
  env: NodeJS.ProcessEnv;
}): string[] {
  const configuredChannelIds = new Set(
    listPotentialConfiguredChannelIds(params.config, params.env).map((id) => id.trim()),
  );
  const pluginsConfig = normalizePluginsConfig(params.config.plugins);
  // Startup must classify allowlist exceptions against the raw config snapshot,
  // not the auto-enabled effective snapshot, or configured-only channels can be
  // misclassified as explicit enablement.
  const activationSource = createPluginActivationSource({
    config: params.activationSourceConfig ?? params.config,
  });
  const requiredAgentHarnessPluginIds = new Set(
    collectConfiguredAgentHarnessRuntimes(
      params.activationSourceConfig ?? params.config,
      params.env,
    ).flatMap((runtime) =>
      resolveManifestActivationPluginIds({
        trigger: {
          kind: "agentHarness",
          runtime,
        },
        config: params.config,
        workspaceDir: params.workspaceDir,
        env: params.env,
        cache: true,
      }),
    ),
  );
  const startupDreamingPluginIds = resolveGatewayStartupDreamingPluginIds(params.config);
  const explicitMemorySlotStartupPluginId = resolveExplicitMemorySlotStartupPluginId(
    params.activationSourceConfig ?? params.config,
  );
  return loadPluginManifestRegistry({
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
  })
    .plugins.filter((plugin) => {
      if (plugin.channels.some((channelId) => configuredChannelIds.has(channelId))) {
        return true;
      }
      if (requiredAgentHarnessPluginIds.has(plugin.id)) {
        const activationState = resolveEffectivePluginActivationState({
          id: plugin.id,
          origin: plugin.origin,
          config: pluginsConfig,
          rootConfig: params.config,
          enabledByDefault: plugin.enabledByDefault,
          activationSource,
        });
        return activationState.enabled;
      }
      if (
        !shouldConsiderForGatewayStartup({
          plugin,
          startupDreamingPluginIds,
          explicitMemorySlotStartupPluginId,
        })
      ) {
        return false;
      }
      const activationState = resolveEffectivePluginActivationState({
        id: plugin.id,
        origin: plugin.origin,
        config: pluginsConfig,
        rootConfig: params.config,
        enabledByDefault: plugin.enabledByDefault,
        activationSource,
      });
      if (!activationState.enabled) {
        return false;
      }
      if (plugin.origin !== "bundled") {
        return activationState.explicitlyEnabled;
      }
      return activationState.source === "explicit" || activationState.source === "default";
    })
    .map((plugin) => plugin.id);
}
