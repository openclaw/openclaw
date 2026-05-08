import type { OpenClawConfig } from "../config/types.js";
import { normalizePluginsConfig, resolveEffectivePluginActivationState } from "./config-state.js";
import { isPluginEnabledByDefaultForPlatform } from "./default-enablement.js";
import { buildInstalledPluginIndex } from "./installed-plugin-index-build.js";
import { loadInstalledPluginIndexInstallRecordsSync } from "./installed-plugin-index-record-reader.js";
import {
  type InstalledPluginIndex,
  type InstalledPluginIndexRecord,
  type LoadInstalledPluginIndexParams,
  type RefreshInstalledPluginIndexParams,
} from "./installed-plugin-index-types.js";

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
  InstalledPluginPackageChannelInfo,
  InstalledPluginStartupInfo,
  LoadInstalledPluginIndexParams,
  RefreshInstalledPluginIndexParams,
} from "./installed-plugin-index-types.js";
export { extractPluginInstallRecordsFromInstalledPluginIndex } from "./installed-plugin-index-install-records.js";
export { diffInstalledPluginIndexInvalidationReasons } from "./installed-plugin-index-invalidation.js";
export { resolveInstalledPluginIndexPolicyHash } from "./installed-plugin-index-policy.js";

export function loadInstalledPluginIndex(
  params: LoadInstalledPluginIndexParams = {},
): InstalledPluginIndex {
  const env = params.env ?? process.env;
  return buildInstalledPluginIndex({
    ...params,
    installRecords:
      params.installRecords ??
      loadInstalledPluginIndexInstallRecordsSync({
        env,
        ...(params.stateDir ? { stateDir: params.stateDir } : {}),
      }),
  });
}

export function refreshInstalledPluginIndex(
  params: RefreshInstalledPluginIndexParams,
): InstalledPluginIndex {
  const env = params.env ?? process.env;
  return buildInstalledPluginIndex({
    ...params,
    refreshReason: params.reason,
    installRecords:
      params.installRecords ??
      loadInstalledPluginIndexInstallRecordsSync({
        env,
        ...(params.stateDir ? { stateDir: params.stateDir } : {}),
      }),
  });
}

export function listInstalledPluginRecords(
  index: InstalledPluginIndex,
): readonly InstalledPluginIndexRecord[] {
  return index.plugins;
}

export function listEnabledInstalledPluginRecords(
  index: InstalledPluginIndex,
  config?: OpenClawConfig,
): readonly InstalledPluginIndexRecord[] {
  if (!config) {
    return index.plugins.filter((plugin) => plugin.enabled);
  }
  return index.plugins.filter((plugin) => isInstalledPluginEnabled(index, plugin.pluginId, config));
}

export function getInstalledPluginRecord(
  index: InstalledPluginIndex,
  pluginId: string,
): InstalledPluginIndexRecord | undefined {
  return index.plugins.find((plugin) => plugin.pluginId === pluginId);
}

export function isInstalledPluginEnabled(
  index: InstalledPluginIndex,
  pluginId: string,
  config?: OpenClawConfig,
): boolean {
  const record = getInstalledPluginRecord(index, pluginId);
  if (!record) {
    return false;
  }
  if (!config) {
    return record.enabled;
  }
  const normalizedConfig = normalizePluginsConfig(config?.plugins);
  const state = resolveEffectivePluginActivationState({
    id: record.pluginId,
    origin: record.origin,
    config: normalizedConfig,
    rootConfig: config,
    enabledByDefault: isPluginEnabledByDefaultForPlatform(record),
  });
  return state.enabled && (record.enabled || state.explicitlyEnabled);
}
