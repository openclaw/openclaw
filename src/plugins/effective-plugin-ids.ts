/** Resolves effective plugin ids from config, installed records, and activation metadata. */
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import { sortUniqueStrings } from "@openclaw/normalization-core/string-normalization";
import {
  listExplicitlyDisabledChannelIdsForConfig,
  listPotentialConfiguredChannelIds,
} from "../channels/config-presence.js";
import { applyPluginAutoEnable } from "../config/plugin-auto-enable.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isVitestRuntimeEnv } from "../infra/env.js";
import {
  listExplicitConfiguredChannelIdsForConfig,
  loadGatewayStartupPluginPlan,
  resolveConfiguredChannelPluginIdsAsync,
} from "./channel-plugin-ids.js";
import {
  normalizePluginsConfig,
  resolveSelectedContextEnginePluginIdFromConfig,
} from "./config-state.js";
import { passesManifestOwnerBasePolicy } from "./manifest-owner-policy.js";
import type { PluginManifestRecord } from "./manifest-registry.js";
import { resolvePluginMetadataSnapshotAsync } from "./plugin-metadata-snapshot.js";
import type { PluginMetadataSnapshot } from "./plugin-metadata-snapshot.types.js";

function collectConfiguredChannelIds(
  config: OpenClawConfig,
  activationSourceConfig: OpenClawConfig,
  env: NodeJS.ProcessEnv,
  discovery: PluginMetadataSnapshot["discovery"],
): string[] {
  const disabled = new Set([
    ...listExplicitlyDisabledChannelIdsForConfig(config),
    ...listExplicitlyDisabledChannelIdsForConfig(activationSourceConfig),
  ]);
  const ids = new Set([
    ...listPotentialConfiguredChannelIds(config, env, {
      includePersistedAuthState: false,
      discovery,
    }),
    ...listExplicitConfiguredChannelIdsForConfig(activationSourceConfig),
  ]);
  return [...ids]
    .map((channelId) => normalizeOptionalLowercaseString(channelId))
    .filter((channelId): channelId is string => {
      if (!channelId) {
        return false;
      }
      return !disabled.has(channelId);
    })
    .toSorted((left, right) => left.localeCompare(right));
}

function addBundledChannelOwnerPluginIds(params: {
  pluginIds: Set<string>;
  config: OpenClawConfig;
  channelIds: readonly string[];
  manifestRecords: readonly PluginManifestRecord[];
}): void {
  // Channel state callbacks run before this pass and may update config.
  const plugins = normalizePluginsConfig(params.config.plugins);
  const channelIds = new Set(params.channelIds);
  if (channelIds.size === 0) {
    return;
  }
  for (const plugin of params.manifestRecords) {
    if (plugin.origin !== "bundled") {
      continue;
    }
    if (
      plugin.channels.some((channelId) =>
        channelIds.has(normalizeOptionalLowercaseString(channelId) ?? ""),
      )
    ) {
      const pluginId = normalizeOptionalLowercaseString(plugin.id);
      if (
        pluginId &&
        passesManifestOwnerBasePolicy({
          plugin: { id: pluginId },
          normalizedConfig: plugins,
          allowRestrictiveAllowlistBypass: true,
        })
      ) {
        params.pluginIds.add(pluginId);
      }
    }
  }
}

/** Lists plugin ids that are effectively enabled for a config/discovery context. */
type ResolveEffectivePluginIdsParams = {
  config: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  workspaceDir?: string;
  bundledPluginsDir?: string;
  /** Prepared metadata for this invocation. Without it every lookup below rebuilds
   * the registry, so callers that already hold a snapshot must pass it. */
  metadataSnapshot?: PluginMetadataSnapshot;
};

export async function resolveEffectivePluginIdsAsync(
  params: ResolveEffectivePluginIdsParams,
): Promise<string[]> {
  const reusable =
    params.bundledPluginsDir || params.metadataSnapshot?.pluginIds
      ? undefined
      : params.metadataSnapshot;
  const env = params.bundledPluginsDir
    ? {
        ...params.env,
        OPENCLAW_BUNDLED_PLUGINS_DIR: params.bundledPluginsDir,
        ...(isVitestRuntimeEnv(params.env) || isVitestRuntimeEnv()
          ? { OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: "1" }
          : {}),
      }
    : params.env;
  const prepared =
    reusable ??
    (await resolvePluginMetadataSnapshotAsync({
      config: params.config,
      env,
      workspaceDir: params.workspaceDir,
    }));
  const autoEnabled = applyPluginAutoEnable({
    config: params.config,
    env,
    manifestRegistry: prepared.manifestRegistry,
    discovery: prepared.discovery,
  });
  const configuredPluginIds = await resolveConfiguredChannelPluginIdsAsync({
    config: autoEnabled.config,
    activationSourceConfig: params.config,
    workspaceDir: params.workspaceDir,
    env,
    manifestRecords: prepared.plugins,
    discovery: prepared.discovery,
  });
  return resolveEffectivePluginIdsWithChannels(
    { ...params, env, metadataSnapshot: prepared },
    { autoEnabled, configuredPluginIds },
  );
}

function resolveEffectivePluginIdsWithChannels(
  params: ResolveEffectivePluginIdsParams & { metadataSnapshot: PluginMetadataSnapshot },
  preparedChannels: {
    autoEnabled: ReturnType<typeof applyPluginAutoEnable>;
    configuredPluginIds: string[];
  },
): string[] {
  const prepared = params.metadataSnapshot;
  const autoEnabled = preparedChannels.autoEnabled;
  const effectiveConfig = autoEnabled.config;
  const plugins = normalizePluginsConfig(effectiveConfig.plugins);
  const ids = new Set(plugins.enabled ? plugins.allow : []);
  if (plugins.enabled) {
    for (const [pluginId, entry] of Object.entries(plugins.entries)) {
      if (entry?.enabled === false) {
        ids.delete(pluginId);
      } else if (
        entry?.enabled === true &&
        (plugins.allow.length === 0 || plugins.allow.includes(pluginId))
      ) {
        ids.add(pluginId);
      }
    }
    for (const pluginId of plugins.deny) {
      ids.delete(pluginId);
    }
  }
  const contextEnginePluginId = resolveSelectedContextEnginePluginIdFromConfig(
    plugins,
    plugins.slots.contextEngine,
  );
  if (contextEnginePluginId) {
    ids.add(contextEnginePluginId);
  }
  const configuredChannelIds = collectConfiguredChannelIds(
    effectiveConfig,
    params.config,
    params.env,
    prepared.discovery,
  );
  for (const pluginId of preparedChannels.configuredPluginIds) {
    ids.add(pluginId);
  }
  addBundledChannelOwnerPluginIds({
    pluginIds: ids,
    config: effectiveConfig,
    channelIds: configuredChannelIds,
    manifestRecords: prepared.plugins,
  });
  for (const pluginId of loadGatewayStartupPluginPlan({
    config: effectiveConfig,
    activationSourceConfig: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
    metadataSnapshot: prepared,
  }).pluginIds) {
    ids.add(pluginId);
  }
  return sortUniqueStrings(ids);
}
