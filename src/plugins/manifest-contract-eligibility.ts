import { sortUniqueStrings } from "@openclaw/normalization-core/string-normalization";
import {
  hasMeaningfulChannelConfigShallow,
  resolveChannelConfigRecord,
} from "../config/channel-config-activation.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { readBundledDiscoveryModeMemoized } from "./bundled-discovery-state.js";
import { isBundledProviderCompatContract } from "./bundled-provider-compat.js";
import { normalizePluginsConfig, type NormalizedPluginsConfig } from "./config-state.js";
import {
  createInstalledPluginEnabledPredicate,
  isInstalledPluginEnabled,
} from "./installed-plugin-index.js";
import { resolveManifestOwnerBasePolicyBlock } from "./manifest-owner-policy.js";
import type { PluginManifestContractListKey, PluginManifestRecord } from "./manifest-registry.js";
import { resolvePluginMetadataSnapshot } from "./plugin-metadata-snapshot.js";
import type {
  PluginMetadataManifestView,
  PluginMetadataRegistryView,
  PluginMetadataSnapshot,
} from "./plugin-metadata-snapshot.types.js";

/** Enforces owner-specific policy while preserving bundled speech/global compatibility. */
export function isManifestPluginOwnerAllowedByControlPlanePolicy(params: {
  plugin: Pick<PluginManifestRecord, "id" | "origin"> & {
    channels?: readonly string[];
  };
  config?: OpenClawConfig;
  /** Batch callers carry the policy normalized from this same config. */
  normalizedConfig?: NormalizedPluginsConfig;
  allowRestrictiveAllowlistBypass?: boolean;
  allowBundledProviderCompat?: boolean;
  /** Callers scoped to an explicit env read compat from that env's state root. */
  env?: NodeJS.ProcessEnv;
}): boolean {
  if (!params.config?.plugins) {
    return true;
  }
  const config = params.config;
  const normalized = params.normalizedConfig ?? normalizePluginsConfig(config.plugins);
  // Global disable is owned by each runtime surface; bundled speech remains intentionally usable.
  const normalizedConfig = normalized.enabled ? normalized : { ...normalized, enabled: true };
  const block = resolveManifestOwnerBasePolicyBlock({
    plugin: params.plugin,
    normalizedConfig,
    allowRestrictiveAllowlistBypass:
      params.plugin.origin === "bundled" && params.allowRestrictiveAllowlistBypass === true,
  });
  if (block !== "not-in-allowlist") {
    return block === null;
  }
  if (params.plugin.origin !== "bundled") {
    return false;
  }
  const channelIds = params.plugin.channels ?? [params.plugin.id];
  if (
    channelIds.some((channelId) => {
      const channelConfig = resolveChannelConfigRecord(config, channelId);
      return channelConfig?.enabled !== false && hasMeaningfulChannelConfigShallow(channelConfig);
    })
  ) {
    return true;
  }
  return (
    params.allowBundledProviderCompat === true &&
    readBundledDiscoveryModeMemoized(params.env) === "compat"
  );
}

export function isManifestPluginAvailableForControlPlane(
  params: Parameters<typeof isManifestPluginOwnerAllowedByControlPlanePolicy>[0] & {
    snapshot: Pick<PluginMetadataSnapshot, "index">;
    plugin: Pick<PluginManifestRecord, "enabledByDefault" | "enabledByDefaultOnPlatforms">;
    /** Batch callers prepare installed enablement for this same config and operation. */
    isInstalledPluginEnabled?: (pluginId: string) => boolean;
  },
): boolean {
  if (!isManifestPluginOwnerAllowedByControlPlanePolicy(params)) {
    return false;
  }
  if (params.plugin.origin === "bundled") {
    return true;
  }
  if (params.isInstalledPluginEnabled) {
    return params.isInstalledPluginEnabled(params.plugin.id);
  }
  return isInstalledPluginEnabled(
    params.snapshot.index,
    params.plugin.id,
    params.config,
    params.env,
  );
}

export function hasManifestContractValue(params: {
  plugin: Pick<PluginManifestRecord, "contracts">;
  contract: PluginManifestContractListKey;
  value?: string;
}): boolean {
  const values = params.plugin.contracts?.[params.contract] ?? [];
  return values.length > 0 && (!params.value || values.includes(params.value));
}

export function listAvailableManifestContractPlugins(params: {
  snapshot: Pick<PluginMetadataSnapshot, "index" | "plugins">;
  contract: PluginManifestContractListKey;
  value?: string;
  config?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): PluginManifestRecord[] {
  const normalizedConfig = normalizePluginsConfig(params.config?.plugins);
  const isEnabled = createInstalledPluginEnabledPredicate(
    params.snapshot.index.plugins,
    params.config,
    params.env,
  );
  return params.snapshot.plugins.filter(
    (plugin) =>
      hasManifestContractValue({
        plugin,
        contract: params.contract,
        value: params.value,
      }) &&
      isManifestPluginAvailableForControlPlane({
        snapshot: params.snapshot,
        plugin,
        config: params.config,
        normalizedConfig,
        isInstalledPluginEnabled: isEnabled,
        env: params.env,
        allowBundledProviderCompat: isBundledProviderCompatContract(params.contract),
      }),
  );
}

export function listAvailableManifestContractValues(
  params: Omit<Parameters<typeof listAvailableManifestContractPlugins>[0], "value">,
): string[] {
  return sortUniqueStrings(
    listAvailableManifestContractPlugins(params).flatMap(
      (plugin) => plugin.contracts?.[params.contract] ?? [],
    ),
  );
}

export function loadManifestContractSnapshot(
  params: Parameters<typeof loadManifestMetadataSnapshot>[0],
): PluginMetadataManifestView {
  const snapshot = loadManifestMetadataSnapshot(params);
  return {
    index: snapshot.index,
    plugins: snapshot.plugins,
    byPluginId: snapshot.byPluginId,
  };
}

export function loadManifestMetadataRegistry(
  params: Parameters<typeof loadManifestMetadataSnapshot>[0],
): PluginMetadataRegistryView {
  const snapshot = loadManifestMetadataSnapshot(params);
  return {
    index: snapshot.index,
    manifestRegistry: snapshot.manifestRegistry,
  };
}

export function loadManifestMetadataSnapshot(params: {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
}): PluginMetadataSnapshot {
  return resolvePluginMetadataSnapshot({
    config: params.config,
    env: params.env ?? process.env,
    ...(params.workspaceDir ? { workspaceDir: params.workspaceDir } : {}),
    allowWorkspaceScopedCurrent: params.workspaceDir === undefined,
  });
}
