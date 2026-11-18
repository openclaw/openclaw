import path from "node:path";
import { buildBackupArchivePath } from "../infra/backup-archive-path-policy.js";
import type { BackupSymbolicLink } from "../infra/backup-archive-path-policy.js";
import {
  type BackupManifest,
  type NormalizedArchiveEntry,
  isRegularArchiveFile,
} from "./backup-verify-manifest.js";

export function resolveBackupRecoveryConfig(
  manifest: BackupManifest,
  entries: readonly NormalizedArchiveEntry[],
  symbolicLinks: readonly BackupSymbolicLink[],
) {
  const contextSource =
    manifest.paths?.configPath ??
    manifest.assets.find((asset) => asset.kind === "config")?.sourcePath;
  if (!contextSource) {
    return {};
  }
  const recoveryConfigContextPath = buildBackupArchivePath(manifest.archiveRoot, contextSource);
  let source = manifest.paths?.configSourcePath ?? contextSource;
  if (!manifest.paths?.configSourcePath) {
    // Legacy archives can recover a recorded first hop when its payload was captured.
    const link = symbolicLinks.find(({ entryPath }) => entryPath === recoveryConfigContextPath);
    if (link) {
      const sourcePaths = manifest.platform === "win32" ? path.win32 : path.posix;
      source = sourcePaths.resolve(sourcePaths.dirname(contextSource), link.linkpath);
    }
  }
  const recoveryConfigPath = buildBackupArchivePath(manifest.archiveRoot, source);
  return {
    recoveryConfigContextPath,
    recoveryConfigPath: entries.some(
      (entry) => entry.normalized === recoveryConfigPath && isRegularArchiveFile(entry.type),
    )
      ? recoveryConfigPath
      : undefined,
  };
}
