import { replaceConfigFile } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import {
  loadInstalledPluginIndexInstallRecords,
  PLUGIN_INSTALLS_CONFIG_PATH,
  writePersistedInstalledPluginIndexInstallRecords,
} from "../plugins/installed-plugin-index-records.js";

export async function commitPluginInstallRecordsWithConfig(params: {
  previousInstallRecords?: Record<string, PluginInstallRecord>;
  nextInstallRecords: Record<string, PluginInstallRecord>;
  nextConfig: OpenClawConfig;
  baseHash?: string;
}): Promise<void> {
  const previousInstallRecords =
    params.previousInstallRecords ?? (await loadInstalledPluginIndexInstallRecords());
  await writePersistedInstalledPluginIndexInstallRecords(params.nextInstallRecords);
  try {
    await replaceConfigFile({
      nextConfig: params.nextConfig,
      ...(params.baseHash !== undefined ? { baseHash: params.baseHash } : {}),
      writeOptions: { unsetPaths: [Array.from(PLUGIN_INSTALLS_CONFIG_PATH)] },
    });
  } catch (error) {
    try {
      await writePersistedInstalledPluginIndexInstallRecords(previousInstallRecords);
    } catch (rollbackError) {
      throw new Error(
        "Failed to commit plugin install records and could not restore the previous plugin index",
        { cause: rollbackError },
      );
    }
    throw error;
  }
}
