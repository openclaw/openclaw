import {
  deleteOpenClawStateKvJson,
  writeOpenClawStateKvJson,
  type OpenClawStateJsonValue,
} from "../state/openclaw-state-kv.js";
import { resolveCompatibilityHostVersion } from "../version.js";
import { normalizePluginsConfig, resolveEffectiveEnableState } from "./config-state.js";
import { clearCurrentPluginMetadataSnapshotState } from "./current-plugin-metadata-state.js";
import { isPluginEnabledByDefaultForPlatform } from "./default-enablement.js";
import { buildInstalledPluginIndex } from "./installed-plugin-index-build.js";
import { hashJson } from "./installed-plugin-index-hash.js";
import { extractPluginInstallRecordsFromInstalledPluginIndex } from "./installed-plugin-index-install-records.js";
import { diffInstalledPluginIndexInvalidationReasons } from "./installed-plugin-index-invalidation.js";
import {
  INSTALLED_PLUGIN_INDEX_KV_KEY,
  INSTALLED_PLUGIN_INDEX_KV_SCOPE,
  readPersistedInstalledPluginIndex,
  readPersistedInstalledPluginIndexSync,
  resolveInstalledPluginIndexStateDbOptions,
} from "./installed-plugin-index-persisted-read.js";
import {
  resolveCompatRegistryVersion,
  resolveInstalledPluginIndexPolicyHash,
} from "./installed-plugin-index-policy.js";
import type { InstalledPluginIndexStoreOptions } from "./installed-plugin-index-store-path.js";
import {
  INSTALLED_PLUGIN_INDEX_MIGRATION_VERSION,
  INSTALLED_PLUGIN_INDEX_VERSION,
  INSTALLED_PLUGIN_INDEX_WARNING,
  type InstalledPluginIndex,
  type InstalledPluginIndexRefreshReason,
  type LoadInstalledPluginIndexParams,
  type RefreshInstalledPluginIndexParams,
} from "./installed-plugin-index-types.js";
export {
  readPersistedInstalledPluginIndex,
  readPersistedInstalledPluginIndexSync,
} from "./installed-plugin-index-persisted-read.js";
export {
  resolveInstalledPluginIndexStorePath,
  type InstalledPluginIndexStoreOptions,
} from "./installed-plugin-index-store-path.js";

export type InstalledPluginIndexStoreState = "missing" | "fresh" | "stale";

export type InstalledPluginIndexStoreInspection = {
  state: InstalledPluginIndexStoreState;
  refreshReasons: readonly InstalledPluginIndexRefreshReason[];
  persisted: InstalledPluginIndex | null;
  current: InstalledPluginIndex;
};

function withInstalledPluginIndexWarning(index: InstalledPluginIndex): InstalledPluginIndex & {
  warning: string;
} {
  return { ...index, warning: INSTALLED_PLUGIN_INDEX_WARNING };
}

export async function writePersistedInstalledPluginIndex(
  index: InstalledPluginIndex,
  options: InstalledPluginIndexStoreOptions = {},
): Promise<void> {
  writeOpenClawStateKvJson(
    INSTALLED_PLUGIN_INDEX_KV_SCOPE,
    INSTALLED_PLUGIN_INDEX_KV_KEY,
    withInstalledPluginIndexWarning(index) as unknown as OpenClawStateJsonValue,
    resolveInstalledPluginIndexStateDbOptions(options),
  );
  clearCurrentPluginMetadataSnapshotState();
}

export function writePersistedInstalledPluginIndexSync(
  index: InstalledPluginIndex,
  options: InstalledPluginIndexStoreOptions = {},
): void {
  writeOpenClawStateKvJson(
    INSTALLED_PLUGIN_INDEX_KV_SCOPE,
    INSTALLED_PLUGIN_INDEX_KV_KEY,
    withInstalledPluginIndexWarning(index) as unknown as OpenClawStateJsonValue,
    resolveInstalledPluginIndexStateDbOptions(options),
  );
  clearCurrentPluginMetadataSnapshotState();
}

export function deletePersistedInstalledPluginIndexSync(
  options: InstalledPluginIndexStoreOptions = {},
): boolean {
  const removed = deleteOpenClawStateKvJson(
    INSTALLED_PLUGIN_INDEX_KV_SCOPE,
    INSTALLED_PLUGIN_INDEX_KV_KEY,
    resolveInstalledPluginIndexStateDbOptions(options),
  );
  if (removed) {
    clearCurrentPluginMetadataSnapshotState();
  }
  return removed;
}

function hasPolicyRefreshTargets(
  persisted: InstalledPluginIndex,
  policyPluginIds: readonly string[] | undefined,
): boolean {
  if (!policyPluginIds || policyPluginIds.length === 0) {
    return true;
  }
  const pluginIds = new Set(persisted.plugins.map((plugin) => plugin.pluginId));
  return policyPluginIds.every((pluginId) => pluginIds.has(pluginId));
}

function canRefreshPersistedPolicyState(
  persisted: InstalledPluginIndex | null,
  params: RefreshInstalledPluginIndexParams & InstalledPluginIndexStoreOptions,
): persisted is InstalledPluginIndex {
  if (!persisted || params.reason !== "policy-changed") {
    return false;
  }
  const env = params.env ?? process.env;
  if (
    persisted.version !== INSTALLED_PLUGIN_INDEX_VERSION ||
    persisted.hostContractVersion !== resolveCompatibilityHostVersion(env) ||
    persisted.compatRegistryVersion !== resolveCompatRegistryVersion() ||
    persisted.migrationVersion !== INSTALLED_PLUGIN_INDEX_MIGRATION_VERSION
  ) {
    return false;
  }
  if (
    params.installRecords &&
    hashJson(params.installRecords) !== hashJson(persisted.installRecords ?? {})
  ) {
    return false;
  }
  return hasPolicyRefreshTargets(persisted, params.policyPluginIds);
}

function refreshPersistedPolicyState(
  persisted: InstalledPluginIndex,
  params: RefreshInstalledPluginIndexParams,
): InstalledPluginIndex {
  const normalizedConfig = normalizePluginsConfig(params.config?.plugins);
  return {
    ...persisted,
    policyHash: resolveInstalledPluginIndexPolicyHash(params.config),
    generatedAtMs: (params.now?.() ?? new Date()).getTime(),
    refreshReason: params.reason,
    plugins: persisted.plugins.map((plugin) => ({
      ...plugin,
      enabled: resolveEffectiveEnableState({
        id: plugin.pluginId,
        origin: plugin.origin,
        config: normalizedConfig,
        rootConfig: params.config,
        enabledByDefault: isPluginEnabledByDefaultForPlatform(plugin),
      }).enabled,
    })),
  };
}

export async function inspectPersistedInstalledPluginIndex(
  params: LoadInstalledPluginIndexParams & InstalledPluginIndexStoreOptions = {},
): Promise<InstalledPluginIndexStoreInspection> {
  const persisted = await readPersistedInstalledPluginIndex(params);
  const current = buildInstalledPluginIndex({
    ...params,
    installRecords:
      params.installRecords ?? extractPluginInstallRecordsFromInstalledPluginIndex(persisted) ?? {},
  });
  if (!persisted) {
    return {
      state: "missing",
      refreshReasons: ["missing"],
      persisted: null,
      current,
    };
  }

  const refreshReasons = diffInstalledPluginIndexInvalidationReasons(persisted, current);
  return {
    state: refreshReasons.length > 0 ? "stale" : "fresh",
    refreshReasons,
    persisted,
    current,
  };
}

export async function refreshPersistedInstalledPluginIndex(
  params: RefreshInstalledPluginIndexParams & InstalledPluginIndexStoreOptions,
): Promise<InstalledPluginIndex> {
  const persisted =
    params.reason === "policy-changed" || !params.installRecords
      ? await readPersistedInstalledPluginIndex(params)
      : null;
  if (canRefreshPersistedPolicyState(persisted, params)) {
    const index = refreshPersistedPolicyState(persisted, params);
    await writePersistedInstalledPluginIndex(index, params);
    return index;
  }
  const index = buildInstalledPluginIndex({
    ...params,
    refreshReason: params.reason,
    installRecords:
      params.installRecords ?? extractPluginInstallRecordsFromInstalledPluginIndex(persisted) ?? {},
  });
  await writePersistedInstalledPluginIndex(index, params);
  return index;
}

export function refreshPersistedInstalledPluginIndexSync(
  params: RefreshInstalledPluginIndexParams & InstalledPluginIndexStoreOptions,
): InstalledPluginIndex {
  const persisted =
    params.reason === "policy-changed" || !params.installRecords
      ? readPersistedInstalledPluginIndexSync(params)
      : null;
  if (canRefreshPersistedPolicyState(persisted, params)) {
    const index = refreshPersistedPolicyState(persisted, params);
    writePersistedInstalledPluginIndexSync(index, params);
    return index;
  }
  const index = buildInstalledPluginIndex({
    ...params,
    refreshReason: params.reason,
    installRecords:
      params.installRecords ?? extractPluginInstallRecordsFromInstalledPluginIndex(persisted) ?? {},
  });
  writePersistedInstalledPluginIndexSync(index, params);
  return index;
}
