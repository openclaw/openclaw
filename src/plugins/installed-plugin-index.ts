/** Public installed-plugin-index API for load, refresh, policy hash, and invalidation checks. */
import type { OpenClawConfig } from "../config/types.js";
import { resolveCompatibilityHostVersion } from "../version.js";
import { withBundledPluginEnablementCompat } from "./bundled-compat.js";
import { isBundledProviderCompatPlugin } from "./bundled-provider-compat.js";
import {
  createPluginActivationSource,
  normalizePluginsConfig,
  resolveEffectiveEnableState,
  resolveEffectivePluginActivationState,
  type PluginActivationConfigSource,
} from "./config-state.js";
import { isPluginEnabledByDefaultForPlatform } from "./default-enablement.js";
import { discoverOpenClawPlugins, type PluginDiscoveryResult } from "./discovery.js";
import { hasConfigPathActivationMetadataMigration } from "./installed-plugin-index-config-path-scope.js";
import { hashJson } from "./installed-plugin-index-hash.js";
import {
  isInstalledPluginIndexInstallOwnerAmbiguous,
  resolveInstalledPluginIndexInstallOwner,
} from "./installed-plugin-index-install-owner.js";
import { normalizeInstallRecordMap } from "./installed-plugin-index-install-records.js";
import {
  resolveCompatRegistryVersion,
  resolveInstalledPluginIndexPolicyHash,
} from "./installed-plugin-index-policy.js";
import {
  buildInstalledPluginIndexRecords,
  type InstalledPluginIndexInventoryRecord,
} from "./installed-plugin-index-record-builder.js";
import { loadInstalledPluginIndexInstallRecordsSync } from "./installed-plugin-index-record-reader.js";
import { resolveInstalledPluginIndexStorePath } from "./installed-plugin-index-store-path.js";
import {
  INSTALLED_PLUGIN_INDEX_MIGRATION_VERSION,
  INSTALLED_PLUGIN_INDEX_VERSION,
  INSTALLED_PLUGIN_INDEX_WARNING,
  type InstalledPluginIndex,
  type InstalledPluginIndexRecord,
  type InstalledPluginIndexRefreshReason,
  type LoadInstalledPluginIndexParams,
  type RefreshInstalledPluginIndexParams,
} from "./installed-plugin-index-types.js";
import {
  loadPluginManifestRegistryCore,
  type PluginManifestRegistry,
} from "./manifest-registry.js";

export {
  INSTALLED_PLUGIN_INDEX_MIGRATION_VERSION,
  INSTALLED_PLUGIN_INDEX_VERSION,
  INSTALLED_PLUGIN_INDEX_WARNING,
} from "./installed-plugin-index-types.js";
export type {
  InstalledPluginIndex,
  InstalledPluginIndexRecord,
  InstalledPluginIndexRefreshReason,
  InstalledPluginInstallRecordInfo,
  LoadInstalledPluginIndexParams,
  RefreshInstalledPluginIndexParams,
} from "./installed-plugin-index-types.js";
export { extractPluginInstallRecordsFromInstalledPluginIndex } from "./installed-plugin-index-install-records.js";
export { hasMissingConfigPathActivationMetadata } from "./installed-plugin-index-config-path-scope.js";
export { resolveInstalledPluginIndexPolicyHash } from "./installed-plugin-index-policy.js";

function buildInstalledPluginIndex(
  params: LoadInstalledPluginIndexParams & { refreshReason?: InstalledPluginIndexRefreshReason },
): {
  index: InstalledPluginIndex;
  discovery: PluginDiscoveryResult | undefined;
  manifestRegistry: PluginManifestRegistry;
} {
  const env = params.env ?? process.env;
  const installRecords = normalizeInstallRecordMap(
    params.installRecords ??
      loadInstalledPluginIndexInstallRecordsSync({
        env,
        ...(params.stateDir ? { stateDir: params.stateDir } : {}),
        ...(params.pluginIndexFilePath ? { filePath: params.pluginIndexFilePath } : {}),
      }),
  );
  const baseDiscovery = params.candidates
    ? { candidates: params.candidates, diagnostics: params.diagnostics ?? [] }
    : (params.discovery ??
      discoverOpenClawPlugins({
        workspaceDir: params.workspaceDir,
        extraPaths: normalizePluginsConfig(params.config?.plugins).loadPaths,
        env,
        installRecords,
      }));
  const discovery =
    !params.candidates && params.diagnostics?.length
      ? {
          ...baseDiscovery,
          diagnostics: [...baseDiscovery.diagnostics, ...params.diagnostics],
        }
      : baseDiscovery;
  const registry = loadPluginManifestRegistryCore({
    registryPath: resolveInstalledPluginIndexStorePath({
      env,
      stateDir: params.stateDir,
      filePath: params.pluginIndexFilePath,
    }),
    config: params.config,
    workspaceDir: params.workspaceDir,
    env,
    candidates: discovery.candidates,
    diagnostics: discovery.diagnostics,
    installRecords,
  });
  const diagnostics = [...(registry.diagnostics ?? [])];
  const generatedAtMs = (params.now?.() ?? new Date()).getTime();
  const plugins = projectInstalledPluginIndexPolicy({
    plugins: buildInstalledPluginIndexRecords({
      candidates: discovery.candidates,
      registry,
      env,
      diagnostics,
      installRecords,
    }),
    config: params.config,
    env,
    artifactPreservingReadOnly: params.artifactPreservingReadOnly,
  });

  return {
    index: {
      version: INSTALLED_PLUGIN_INDEX_VERSION,
      warning: INSTALLED_PLUGIN_INDEX_WARNING,
      hostContractVersion: resolveCompatibilityHostVersion(env),
      compatRegistryVersion: resolveCompatRegistryVersion(),
      migrationVersion: INSTALLED_PLUGIN_INDEX_MIGRATION_VERSION,
      policyHash: resolveInstalledPluginIndexPolicyHash(params.config, env, {
        artifactPreservingReadOnly: params.artifactPreservingReadOnly,
      }),
      generatedAtMs,
      ...(params.workspaceDir !== undefined ? { workspaceDir: params.workspaceDir } : {}),
      ...(params.refreshReason ? { refreshReason: params.refreshReason } : {}),
      installRecords,
      plugins,
      diagnostics,
    },
    discovery: params.candidates ? undefined : discovery,
    manifestRegistry: registry,
  };
}

/**
 * Activation is the only config-owned index fact. A policy change re-projects the
 * same disk inventory in memory; only install, uninstall or source changes rescan.
 */
export function projectInstalledPluginIndexPolicy(params: {
  plugins: readonly InstalledPluginIndexInventoryRecord[];
  config?: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  artifactPreservingReadOnly?: boolean;
}): InstalledPluginIndexRecord[] {
  const activationConfig = withBundledPluginEnablementCompat({
    config: params.config,
    env: params.env,
    pluginIds: params.plugins.filter(isInstalledBundledProvider).map((plugin) => plugin.pluginId),
    activation: "defaults",
    artifactPreservingReadOnly: params.artifactPreservingReadOnly,
  });
  const normalizedConfig = normalizePluginsConfig(activationConfig?.plugins);
  return params.plugins.map((plugin) => ({
    ...plugin,
    enabled: resolveEffectiveEnableState({
      id: plugin.pluginId,
      origin: plugin.origin,
      channelIds: plugin.contributions?.channels,
      config: normalizedConfig,
      rootConfig: activationConfig,
      enabledByDefault: isPluginEnabledByDefaultForPlatform(plugin),
    }).enabled,
  }));
}

export function loadInstalledPluginIndex(
  params: LoadInstalledPluginIndexParams = {},
): InstalledPluginIndex {
  return buildInstalledPluginIndex(params).index;
}

export function loadInstalledPluginIndexWithDiscovery(
  params: LoadInstalledPluginIndexParams = {},
): {
  index: InstalledPluginIndex;
  discovery: PluginDiscoveryResult | undefined;
  manifestRegistry: PluginManifestRegistry;
} {
  return buildInstalledPluginIndex(params);
}

/** True when a persisted index cannot represent the requested workspace discovery scope. */
export function hasInstalledPluginIndexWorkspaceScopeMismatch(
  index: InstalledPluginIndex,
  workspaceDir: string | undefined,
): boolean {
  if (workspaceDir !== undefined) {
    return index.workspaceDir !== workspaceDir;
  }
  return (
    index.workspaceDir !== undefined ||
    index.plugins.some((plugin) => plugin.origin === "workspace")
  );
}

export function refreshInstalledPluginIndex(
  params: RefreshInstalledPluginIndexParams,
): InstalledPluginIndex {
  return buildInstalledPluginIndex({ ...params, refreshReason: params.reason }).index;
}

export function isInstalledPluginEnabled(
  index: InstalledPluginIndex,
  pluginId: string,
  config?: OpenClawConfig,
  env?: NodeJS.ProcessEnv,
): boolean {
  const record = index.plugins.find((plugin) => plugin.pluginId === pluginId);
  if (!record || !config) {
    return record?.enabled ?? false;
  }
  return createInstalledPluginEnabledPredicate([record], config, env)(pluginId);
}

function isInstalledBundledProvider(record: InstalledPluginIndexInventoryRecord): boolean {
  return isBundledProviderCompatPlugin({
    origin: record.origin,
    providers: record.contributions?.providers,
    contracts: record.contributions?.contracts,
  });
}

/** Prepare live policy for one synchronous operation, never across config/root changes. */
export function createInstalledPluginEnabledPredicate(
  plugins: readonly InstalledPluginIndexRecord[],
  config?: OpenClawConfig,
  env?: NodeJS.ProcessEnv,
): (pluginId: string) => boolean {
  let source: PluginActivationConfigSource | undefined;
  let bundledSource: PluginActivationConfigSource | undefined;
  let records: Map<string, InstalledPluginIndexRecord> | undefined;
  return (pluginId) => {
    if (!records) {
      records = new Map();
      // Inventory is fixed for this operation; retain the first duplicate like find().
      for (const entry of plugins) {
        if (!records.has(entry.pluginId)) {
          records.set(entry.pluginId, entry);
        }
      }
    }
    const record = records.get(pluginId);
    if (!record || !config) {
      return record?.enabled ?? false;
    }
    let activationSource: PluginActivationConfigSource;
    if (isInstalledBundledProvider(record)) {
      if (!bundledSource) {
        const bundledConfig = withBundledPluginEnablementCompat({
          config,
          env,
          pluginIds: plugins.filter(isInstalledBundledProvider).map((entry) => entry.pluginId),
          activation: "defaults",
        });
        // Provider compat may extend an allowlist; non-provider owners must retain the original.
        bundledSource =
          bundledConfig === config
            ? (source ??= createPluginActivationSource({ config }))
            : createPluginActivationSource({ config: bundledConfig });
      }
      activationSource = bundledSource;
    } else {
      activationSource = source ??= createPluginActivationSource({ config });
    }
    return resolveEffectivePluginActivationState({
      id: record.pluginId,
      origin: record.origin,
      channelIds: record.contributions?.channels,
      config: activationSource.plugins,
      rootConfig: activationSource.rootConfig,
      activationSource,
      enabledByDefault: isPluginEnabledByDefaultForPlatform(record),
    }).enabled;
  };
}

export function diffInstalledPluginIndexInvalidationReasons(
  previous: InstalledPluginIndex,
  current: InstalledPluginIndex,
): readonly InstalledPluginIndexRefreshReason[] {
  const reasons = new Set<InstalledPluginIndexRefreshReason>();
  if (previous.version !== current.version) {
    reasons.add("missing");
  }
  if (previous.hostContractVersion !== current.hostContractVersion) {
    reasons.add("host-contract-changed");
  }
  if (previous.compatRegistryVersion !== current.compatRegistryVersion) {
    reasons.add("compat-registry-changed");
  }
  if (previous.migrationVersion !== current.migrationVersion) {
    reasons.add("migration");
  }
  if (previous.policyHash !== current.policyHash) {
    reasons.add("policy-changed");
  }
  if (hashJson(previous.installRecords ?? {}) !== hashJson(current.installRecords ?? {})) {
    reasons.add("source-changed");
  }

  const previousByPluginId = new Map(previous.plugins.map((plugin) => [plugin.pluginId, plugin]));
  const currentByPluginId = new Map(current.plugins.map((plugin) => [plugin.pluginId, plugin]));
  for (const [pluginId, previousPlugin] of previousByPluginId) {
    const currentPlugin = currentByPluginId.get(pluginId);
    if (!currentPlugin) {
      reasons.add("source-changed");
      continue;
    }
    if (
      previousPlugin.rootDir !== currentPlugin.rootDir ||
      previousPlugin.manifestPath !== currentPlugin.manifestPath ||
      previousPlugin.source !== currentPlugin.source ||
      previousPlugin.setupSource !== currentPlugin.setupSource ||
      resolveInstalledPluginIndexInstallOwner(previousPlugin) !==
        resolveInstalledPluginIndexInstallOwner(currentPlugin) ||
      isInstalledPluginIndexInstallOwnerAmbiguous(previousPlugin) !==
        isInstalledPluginIndexInstallOwnerAmbiguous(currentPlugin) ||
      previousPlugin.installRecordHash !== currentPlugin.installRecordHash
    ) {
      reasons.add("source-changed");
    }
    if (previousPlugin.enabled !== currentPlugin.enabled) {
      reasons.add("policy-changed");
    }
    if (
      hasConfigPathActivationMetadataMigration({
        previous: previousPlugin,
        current: currentPlugin,
      })
    ) {
      reasons.add("migration");
    }
    if (
      previousPlugin.manifestHash !== currentPlugin.manifestHash ||
      previousPlugin.doctorContractHash !== currentPlugin.doctorContractHash
    ) {
      reasons.add("stale-manifest");
    }
    if (
      previousPlugin.packageVersion !== currentPlugin.packageVersion ||
      previousPlugin.packageJson?.path !== currentPlugin.packageJson?.path ||
      previousPlugin.packageJson?.hash !== currentPlugin.packageJson?.hash
    ) {
      reasons.add("stale-package");
    }
  }
  for (const [pluginId, plugin] of currentByPluginId) {
    if (!previousByPluginId.has(pluginId) && plugin.enabled) {
      reasons.add("source-changed");
    }
  }

  return Array.from(reasons).toSorted((left, right) => left.localeCompare(right));
}
