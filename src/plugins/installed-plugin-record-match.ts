import type { PluginInstallRecord } from "../config/types.plugins.js";
import { resolveUserPath } from "../utils.js";
import type { PluginCandidate } from "./discovery.js";
import {
  resolveTrustedSourceLinkedOfficialClawHubInstall,
  resolveTrustedSourceLinkedOfficialNpmSpec,
} from "./official-external-install-records.js";
import {
  getOfficialExternalPluginCatalogEntryForPackage,
  resolveOfficialExternalPluginId,
} from "./official-external-plugin-catalog.js";
import { isPathInside, safeRealpathSync } from "./path-safety.js";

export function matchesInstalledPluginRecord(params: {
  pluginId: string;
  candidate: PluginCandidate;
  env: NodeJS.ProcessEnv;
  installRecords: Record<string, PluginInstallRecord>;
}): boolean {
  if (params.candidate.origin !== "global" && params.candidate.origin !== "config") {
    return false;
  }
  const record = params.installRecords[params.pluginId];
  if (!record) {
    return false;
  }
  const resolveCanonicalPath = (entry: string): string => {
    const resolved = resolveUserPath(entry, params.env);
    return safeRealpathSync(resolved) ?? resolved;
  };
  const candidateRoots = [params.candidate.rootDir, params.candidate.packageDir]
    .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    .map(resolveCanonicalPath);
  const candidateSources = [params.candidate.source, params.candidate.setupSource]
    .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    .map(resolveCanonicalPath);
  const installPath =
    typeof record.installPath === "string" && record.installPath.trim()
      ? resolveCanonicalPath(record.installPath)
      : undefined;
  const sourcePath =
    typeof record.sourcePath === "string" && record.sourcePath.trim()
      ? resolveCanonicalPath(record.sourcePath)
      : undefined;
  const sourceMatchesRoot = (rootPath: string): boolean =>
    candidateSources.some(
      (candidateSource) => candidateSource === rootPath || isPathInside(rootPath, candidateSource),
    );
  return Boolean(
    (installPath &&
      (candidateRoots.some((candidateRoot) => candidateRoot === installPath) ||
        sourceMatchesRoot(installPath))) ||
    (sourcePath && sourceMatchesRoot(sourcePath)),
  );
}

export function isTrustedOfficialPluginInstall(params: {
  pluginId: string;
  candidate: PluginCandidate;
  env: NodeJS.ProcessEnv;
  installRecords: Record<string, PluginInstallRecord>;
}): boolean {
  if (
    !matchesInstalledPluginRecord(params) ||
    !params.candidate.packageName ||
    !params.installRecords[params.pluginId]
  ) {
    return false;
  }
  const catalogEntry = getOfficialExternalPluginCatalogEntryForPackage(
    params.candidate.packageName,
  );
  if (!catalogEntry || resolveOfficialExternalPluginId(catalogEntry) !== params.pluginId) {
    return false;
  }
  const record = params.installRecords[params.pluginId];
  return Boolean(
    resolveTrustedSourceLinkedOfficialNpmSpec({ pluginId: params.pluginId, record }) ||
    resolveTrustedSourceLinkedOfficialClawHubInstall({ pluginId: params.pluginId, record }),
  );
}
