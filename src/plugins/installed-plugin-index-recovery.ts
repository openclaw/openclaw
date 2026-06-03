import fs from "node:fs";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { resolveUserPath } from "../utils.js";
import { extractPluginInstallRecordsFromInstalledPluginIndex } from "./installed-plugin-index-install-records.js";
import type { InstalledPluginIndex } from "./installed-plugin-index-types.js";

export function hasRecoverableInstallRecordsMissingFromIndex(
  index: InstalledPluginIndex,
  installRecords: Record<string, PluginInstallRecord>,
  env: NodeJS.ProcessEnv,
): boolean {
  const persistedRecords = extractPluginInstallRecordsFromInstalledPluginIndex(index);
  const persistedPluginIds = new Set(index.plugins.map((plugin) => plugin.pluginId));
  return Object.entries(installRecords).some(([pluginId, record]) => {
    if (persistedRecords[pluginId] && persistedPluginIds.has(pluginId)) {
      return false;
    }
    const installPaths = [record.installPath, record.sourcePath].filter(
      (candidate): candidate is string =>
        typeof candidate === "string" && candidate.trim().length > 0,
    );
    if (installPaths.length === 0) {
      return true;
    }
    return installPaths.some((installPath) => fs.existsSync(resolveUserPath(installPath, env)));
  });
}
