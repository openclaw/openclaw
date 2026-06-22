import type { PluginInstallRecord } from "../config/types.plugins.js";
import {
  hasDiscoverableInstalledPluginRecordPath,
  hasDiscoverablePluginRecoveryInput,
  type PluginCandidate,
} from "./discovery.js";
import { extractPluginInstallRecordsFromInstalledPluginIndex } from "./installed-plugin-index-install-records.js";
import type { InstalledPluginIndex } from "./installed-plugin-index-types.js";

export type InstallRecordRecoveryOptions = {
  configLoadPaths?: unknown;
  recoveryCandidates?: readonly PluginCandidate[];
  workspaceDir?: string;
};

function hasInstallRecordPath(record: PluginInstallRecord): boolean {
  return [record.installPath, record.sourcePath].some(
    (candidate) => typeof candidate === "string" && candidate.trim().length > 0,
  );
}

export function hasRecoverableInstallRecordsMissingFromIndex(
  index: InstalledPluginIndex,
  installRecords: Record<string, PluginInstallRecord>,
  env: NodeJS.ProcessEnv,
  options: InstallRecordRecoveryOptions = {},
): boolean {
  const persistedRecords = extractPluginInstallRecordsFromInstalledPluginIndex(index);
  const persistedPluginIds = new Set(index.plugins.map((plugin) => plugin.pluginId));
  return Object.entries(installRecords).some(([pluginId, record]) => {
    if (persistedRecords[pluginId] && persistedPluginIds.has(pluginId)) {
      return false;
    }
    if (!persistedRecords[pluginId]) {
      // Newly recovered records need a rebuild so the persisted snapshot keeps
      // install metadata even when the package cannot produce a plugin candidate.
      return true;
    }
    if (
      hasDiscoverablePluginRecoveryInput({
        pluginId,
        candidates: options.recoveryCandidates,
        configLoadPaths: options.configLoadPaths,
        env,
        ...(options.workspaceDir ? { workspaceDir: options.workspaceDir } : {}),
      })
    ) {
      return true;
    }
    if (!hasInstallRecordPath(record)) {
      // Pathless records can still be recovered by the full refresh through
      // explicit candidates or config load paths, so keep the conservative rebuild.
      return true;
    }
    return hasDiscoverableInstalledPluginRecordPath({
      record,
      env,
      configLoadPaths: options.configLoadPaths,
      ...(options.workspaceDir ? { workspaceDir: options.workspaceDir } : {}),
    });
  });
}
