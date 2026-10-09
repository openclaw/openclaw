/** Builds and compares installed plugin index records for refresh decisions. */
import { copyPluginInstallRecordMap } from "../config/plugin-install-record-map.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import {
  refreshPersistedInstalledPluginIndexWithLeaseSync,
  type InstalledPluginIndexWriteLease,
  type InstalledPluginIndexWriteReceipt,
} from "./installed-plugin-index-store-write.js";
import type { RefreshInstalledPluginIndexParams } from "./installed-plugin-index.js";
export { recordPluginInstallInRecords } from "./installs.js";
export {
  clearLoadInstalledPluginIndexInstallRecordsCache,
  loadInstalledPluginIndexInstallRecords,
  loadInstalledPluginIndexInstallRecordsSync,
  readPersistedInstalledPluginIndexInstallRecords,
} from "./installed-plugin-index-record-reader.js";

/** Config path for legacy plugin install records kept for migration/doctor flows. */
export const PLUGIN_INSTALLS_CONFIG_PATH = ["plugins", "installs"] as const;

/** Options shared by installed plugin index record storage helpers. */
export type InstalledPluginIndexRecordStoreOptions = {
  env?: NodeJS.ProcessEnv;
  stateDir?: string;
  filePath?: string;
};

type InstalledPluginIndexRecordRefreshOptions = InstalledPluginIndexRecordStoreOptions &
  Partial<Omit<RefreshInstalledPluginIndexParams, "reason" | "installRecords">> & {
    now?: () => Date;
  };

/** Refresh persisted install records while holding the plugin lifecycle lease. */
export async function writePersistedInstalledPluginIndexInstallRecordsWithLease(
  records: Record<string, PluginInstallRecord>,
  options: InstalledPluginIndexRecordRefreshOptions & {
    lease: InstalledPluginIndexWriteLease;
  },
): Promise<InstalledPluginIndexWriteReceipt> {
  const { index: _index, ...receipt } = refreshPersistedInstalledPluginIndexWithLeaseSync({
    ...options,
    reason: "source-changed",
    installRecords: records,
  });
  return receipt;
}

/** Returns config with plugin install records attached at the canonical config path. */
export function withPluginInstallRecords(
  config: OpenClawConfig,
  records: Record<string, PluginInstallRecord>,
): OpenClawConfig {
  return {
    ...config,
    plugins: {
      ...config.plugins,
      installs: records,
    },
  };
}

/** Returns config with legacy plugin install records removed. */
export function withoutPluginInstallRecords(
  config: OpenClawConfig,
  options: { preserveEmptyPlugins?: boolean } = {},
): OpenClawConfig {
  if (!config.plugins?.installs) {
    return config;
  }
  const { installs: _installs, ...plugins } = config.plugins;
  if (Object.keys(plugins).length === 0) {
    if (options.preserveEmptyPlugins) {
      return { ...config, plugins: {} };
    }
    const { plugins: _plugins, ...rest } = config;
    return rest;
  }
  return {
    ...config,
    plugins,
  };
}

/** Removes one plugin install record from an in-memory record map. */
export function removePluginInstallRecordFromRecords(
  records: Record<string, PluginInstallRecord>,
  pluginId: string,
): Record<string, PluginInstallRecord> {
  const remaining = copyPluginInstallRecordMap(records);
  delete remaining[pluginId];
  return remaining;
}
