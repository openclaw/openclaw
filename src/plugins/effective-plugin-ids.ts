/** Resolves effective plugin ids from config, installed records, and activation metadata. */
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import { sortUniqueStrings } from "@openclaw/normalization-core/string-normalization";
import {
  listExplicitlyDisabledChannelIdsForConfig,
  listPotentialConfiguredChannelIds,
} from "../channels/config-presence.js";
import { applyPluginAutoEnable } from "../config/plugin-auto-enable.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  listExplicitConfiguredChannelIdsForConfig,
  loadGatewayStartupPluginPlan,
  resolveConfiguredChannelPluginIds,
  resolveConfiguredChannelPluginIdsAsync,
} from "./channel-plugin-ids.js";
import {
  normalizePluginsConfig,
  resolveSelectedContextEnginePluginIdFromConfig,
} from "./config-state.js";
import { loadManifestMetadataSnapshot } from "./manifest-contract-eligibility.js";
import { passesManifestOwnerBasePolicy } from "./manifest-owner-policy.js";
import type { PluginMetadataSnapshot } from "./plugin-metadata-snapshot.types.js";

/** Lists plugin ids that are effectively enabled for a config/discovery context. */
type ResolveEffectivePluginIdsParams = {
  config: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  workspaceDir?: string;
  /** Prepared metadata for this invocation. Without it every lookup below rebuilds
   * the registry, so callers that already hold a snapshot must pass it. */
  metadataSnapshot?: PluginMetadataSnapshot;
};

export function resolveEffectivePluginIds(params: ResolveEffectivePluginIdsParams): string[] {
  return resolveEffectivePluginIdsWithChannels(params);
}

export async function resolveEffectivePluginIdsAsync(
  params: ResolveEffectivePluginIdsParams,
): Promise<string[]> {
  const prepared = params.metadataSnapshot?.pluginIds ? undefined : params.metadataSnapshot;
  const autoEnabled = applyPluginAutoEnable({
    config: params.config,
    env: params.env,
    ...(prepared ? { manifestRegistry: prepared.manifestRegistry } : {}),
    ...(prepared?.discovery ? { discovery: prepared.discovery } : {}),
  });
  const configuredPluginIds = await resolveConfiguredChannelPluginIdsAsync({
    config: autoEnabled.config,
    activationSourceConfig: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
    manifestRecords: prepared?.plugins,
    discovery: prepared?.discovery,
  });
  return resolveEffectivePluginIdsWithChannels(params, { autoEnabled, configuredPluginIds });
}

function resolveEffectivePluginIdsWithChannels(
  params: ResolveEffectivePluginIdsParams,
  preparedChannels?: {
    autoEnabled: ReturnType<typeof applyPluginAutoEnable>;
    configuredPluginIds: string[];
  },
): string[] {
  // Effective ids are a whole-config question. A plugin-scoped snapshot only carries
  // its own manifests, so those callers keep re-deriving.
  const prepared = params.metadataSnapshot?.pluginIds ? undefined : params.metadataSnapshot;
  const autoEnabled =
    preparedChannels?.autoEnabled ??
    applyPluginAutoEnable({
      config: params.config,
      env: params.env,
      ...(prepared ? { manifestRegistry: prepared.manifestRegistry } : {}),
      ...(prepared?.discovery ? { discovery: prepared.discovery } : {}),
    });
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
    plugins.enabled && plugins.slots.contextEngine && plugins.slots.contextEngine !== "legacy"
      ? (
          prepared ??
          loadManifestMetadataSnapshot({
            config: effectiveConfig,
            env: params.env,
            workspaceDir: params.workspaceDir,
          })
        ).plugins
      : [],
  );
  if (contextEnginePluginId) {
    ids.add(contextEnginePluginId);
  }
  const activationSourceConfig = params.config;
  const env = params.env;
  const discovery = prepared?.discovery;
  const disabled = new Set([
    ...listExplicitlyDisabledChannelIdsForConfig(effectiveConfig),
    ...listExplicitlyDisabledChannelIdsForConfig(activationSourceConfig),
  ]);
  const configuredIds = new Set([
    ...listPotentialConfiguredChannelIds(effectiveConfig, env, {
      includePersistedAuthState: false,
      discovery,
    }),
    ...listExplicitConfiguredChannelIdsForConfig(activationSourceConfig),
  ]);
  const configuredChannelIds = [...configuredIds]
    .map((channelId) => normalizeOptionalLowercaseString(channelId))
    .filter((channelId): channelId is string => {
      if (!channelId) {
        return false;
      }
      return !disabled.has(channelId);
    })
    .toSorted((left, right) => left.localeCompare(right));
  const configuredPluginIds =
    preparedChannels?.configuredPluginIds ??
    resolveConfiguredChannelPluginIds({
      config: effectiveConfig,
      activationSourceConfig: params.config,
      workspaceDir: params.workspaceDir,
      env: params.env,
      manifestRecords: prepared?.plugins,
      discovery: prepared?.discovery,
    });
  for (const pluginId of configuredPluginIds) {
    ids.add(pluginId);
  }
  // Channel state callbacks run before this pass and may update config.
  const bundledOwnerPlugins = normalizePluginsConfig(effectiveConfig.plugins);
  const channelIds = new Set(configuredChannelIds);
  if (channelIds.size > 0) {
    const records =
      prepared?.plugins ??
      loadManifestMetadataSnapshot({
        config: effectiveConfig,
        env: params.env,
        workspaceDir: params.workspaceDir,
      }).plugins;
    for (const plugin of records) {
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
            normalizedConfig: bundledOwnerPlugins,
            allowRestrictiveAllowlistBypass: true,
          })
        ) {
          ids.add(pluginId);
        }
      }
    }
  }
  for (const pluginId of loadGatewayStartupPluginPlan({
    config: effectiveConfig,
    activationSourceConfig: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
    ...(prepared ? { metadataSnapshot: prepared } : {}),
  }).pluginIds) {
    ids.add(pluginId);
  }
  return sortUniqueStrings(ids);
}
