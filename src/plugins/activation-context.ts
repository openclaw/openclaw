import { getPublishedConfigRuntimeEnvState } from "../config/config-env-vars.js";
import { applyPluginAutoEnable } from "../config/plugin-auto-enable.js";
import { getRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isDeeplyFrozenPlainData } from "../shared/immutable-data.js";
import { withBundledPluginEnablementCompat } from "./bundled-compat.js";
import {
  createPluginActivationSource,
  normalizePluginId,
  normalizePluginsConfig,
} from "./config-state.js";
import {
  getCurrentPluginMetadataSnapshot,
  isCurrentPluginMetadataSnapshotRuntimeGeneration,
} from "./current-plugin-metadata-snapshot.js";
import type { PluginDiscoveryResult } from "./discovery.js";
import type { PluginManifestRegistry } from "./manifest-registry.js";
import { getPluginMetadataSnapshotCache } from "./plugin-cache.js";

type PluginActivationParams = {
  rawConfig?: OpenClawConfig;
  resolvedConfig?: OpenClawConfig;
  autoEnabledReasons?: Record<string, string[]>;
  env?: NodeJS.ProcessEnv;
  workspaceDir?: string;
  applyAutoEnable?: boolean;
  discovery?: PluginDiscoveryResult;
  manifestRegistry?: PluginManifestRegistry;
};

type BundledCompatActivationParams = PluginActivationParams & {
  activation?: "defaults" | "selected";
  onlyPluginIds?: readonly string[];
  resolveBundledPluginIds: (params: {
    config?: OpenClawConfig;
    workspaceDir?: string;
    env?: NodeJS.ProcessEnv;
    onlyPluginIds?: readonly string[];
    manifestRegistry?: PluginManifestRegistry;
  }) => string[];
};

export function withActivatedPluginIds(params: {
  config?: OpenClawConfig;
  pluginIds: readonly string[];
}): OpenClawConfig | undefined {
  if (params.pluginIds.length === 0) {
    return params.config;
  }
  const originalAllow = params.config?.plugins?.allow ?? [];
  const useAllowlistDiscovery = originalAllow.length > 0;
  const originalAllowSet = useAllowlistDiscovery
    ? new Set(originalAllow.map((id) => normalizePluginId(id)))
    : undefined;
  const allow = new Set(originalAllow);
  const entries = {
    ...params.config?.plugins?.entries,
  };
  let entryChanged = false;
  for (const pluginId of params.pluginIds) {
    const normalized = normalizePluginId(pluginId.trim());
    if (!normalized) {
      continue;
    }
    if (originalAllowSet && !originalAllowSet.has(normalized)) {
      continue;
    }
    allow.add(normalized);
    const existingEntry =
      entries[normalized] ??
      Object.entries(entries).find(([key]) => normalizePluginId(key) === normalized)?.[1];
    const enabled = existingEntry?.enabled !== false;
    entryChanged ||= entries[normalized]?.enabled !== enabled;
    entries[normalized] = {
      ...existingEntry,
      enabled,
    };
  }
  if (!entryChanged && allow.size === originalAllow.length && params.config?.plugins?.entries) {
    return params.config;
  }
  return {
    ...params.config,
    plugins: {
      ...params.config?.plugins,
      ...(allow.size > 0 ? { allow: [...allow] } : {}),
      entries,
    },
  };
}

export function resolveBundledCompatActivationInputs(params: BundledCompatActivationParams) {
  const env = params.env ?? process.env;
  const rawConfig = params.rawConfig ?? params.resolvedConfig;
  let resolvedConfig = params.resolvedConfig ?? params.rawConfig;
  let autoEnabledReasons = params.autoEnabledReasons;

  if (params.applyAutoEnable && rawConfig !== undefined) {
    const capturedConfig =
      rawConfig === getRuntimeConfigSnapshot()
        ? getRuntimeConfigSnapshot({ capture: true })!
        : isDeeplyFrozenPlainData(rawConfig)
          ? rawConfig
          : undefined;
    const currentSnapshot =
      params.manifestRegistry && !capturedConfig
        ? undefined
        : getCurrentPluginMetadataSnapshot({
            config: rawConfig,
            env,
            workspaceDir: params.workspaceDir,
            allowWorkspaceScopedSnapshot: true,
          });
    const defaultDiscoverySnapshot =
      !params.manifestRegistry && normalizePluginsConfig(rawConfig.plugins).loadPaths.length === 0
        ? getCurrentPluginMetadataSnapshot({
            env,
            workspaceDir: params.workspaceDir,
            allowWorkspaceScopedSnapshot: true,
            requireDefaultDiscoveryContext: true,
          })
        : undefined;
    const currentManifestRegistry =
      params.manifestRegistry ??
      currentSnapshot?.manifestRegistry ??
      defaultDiscoverySnapshot?.manifestRegistry;
    const discovery =
      params.discovery ??
      (!params.manifestRegistry
        ? (currentSnapshot?.discovery ?? defaultDiscoverySnapshot?.discovery)
        : undefined);
    // Only the runtime owner can extend preparation beyond a mutable setup turn.
    // Config policy receives these identities without importing the snapshot owner.
    const runtimePreparation =
      capturedConfig &&
      currentSnapshot &&
      isCurrentPluginMetadataSnapshotRuntimeGeneration(currentSnapshot) &&
      currentManifestRegistry === currentSnapshot.manifestRegistry &&
      (!discovery || discovery === currentSnapshot.discovery) &&
      (env === process.env || isDeeplyFrozenPlainData(env))
        ? {
            capturedConfig,
            cache: getPluginMetadataSnapshotCache(currentSnapshot).metadata.autoEnable,
            metadataKey: currentSnapshot,
            envKey: env === process.env ? getPublishedConfigRuntimeEnvState() : env,
          }
        : undefined;
    const autoEnabled = applyPluginAutoEnable({
      config: rawConfig,
      env,
      manifestRegistry: currentManifestRegistry,
      discovery,
      ...(runtimePreparation ? { runtimePreparation } : {}),
    });
    resolvedConfig = autoEnabled.config;
    autoEnabledReasons = autoEnabled.autoEnabledReasons;
  }

  const activationSource = createPluginActivationSource({ config: rawConfig });
  const bundledPluginIds = params.resolveBundledPluginIds({
    config: resolvedConfig,
    workspaceDir: params.workspaceDir,
    env,
    onlyPluginIds: params.onlyPluginIds,
    ...(params.manifestRegistry ? { manifestRegistry: params.manifestRegistry } : {}),
  });
  const config = withBundledPluginEnablementCompat({
    config: resolvedConfig,
    pluginIds: bundledPluginIds,
    env,
    ...(params.activation ? { activation: params.activation } : {}),
  });

  return {
    rawConfig,
    config,
    normalized: normalizePluginsConfig(config?.plugins),
    activationSourceConfig: rawConfig,
    activationSource,
    autoEnabledReasons: autoEnabledReasons ?? {},
  };
}
