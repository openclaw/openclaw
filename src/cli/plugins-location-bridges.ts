import type { ExternalizedBundledPluginBridge } from "../plugins/externalized-bundled-plugins.js";
import { readPersistedInstalledPluginIndex } from "../plugins/installed-plugin-index-store.js";
import type { InstalledPluginIndexRecord } from "../plugins/installed-plugin-index.js";

function buildBridgeFromPersistedBundledRecord(
  record: InstalledPluginIndexRecord,
): ExternalizedBundledPluginBridge | null {
  if (record.origin !== "bundled" || record.enabled === false) {
    return null;
  }
  const npmSpec = record.packageInstall?.npm?.spec;
  if (!npmSpec) {
    return null;
  }
  return {
    bundledPluginId: record.pluginId,
    pluginId: record.pluginId,
    npmSpec,
    channelIds: record.contributions.channels,
  };
}

export async function listPersistedBundledPluginLocationBridges(options: {
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<readonly ExternalizedBundledPluginBridge[]> {
  const index = await readPersistedInstalledPluginIndex(options);
  if (!index) {
    return [];
  }
  return index.plugins.flatMap((record) => {
    const bridge = buildBridgeFromPersistedBundledRecord(record);
    return bridge ? [bridge] : [];
  });
}
