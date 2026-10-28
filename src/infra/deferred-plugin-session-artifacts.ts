import { statSync } from "node:fs";
import {
  statMigrationPath,
  type MigrationArtifactIdentity,
} from "./session-sqlite-migration-artifact.js";
import {
  canonicalMigrationFilePath,
  filterRestoreManifestTargets,
  listSessionSqliteMigrationManifestPaths,
  readSessionSqliteMigrationManifest,
  resolveSessionSqliteMigrationRunsDir,
  sessionSqliteMigrationTargetKey,
  type SessionSqliteMigrationTargetInput,
} from "./session-sqlite-migration-manifest.js";

export type ArchivedSessionSources = Map<
  string,
  Array<{ identity: MigrationArtifactIdentity; path: string; dependencies: readonly string[] }>
>;

type ArchiveScanCacheEntry = { signature: string; archives: ArchivedSessionSources };

/** Doctor asks for the same target once per source; keep the last scans, not the manifests. */
const ARCHIVE_SCAN_CACHE_LIMIT = 16;
const archiveScanCache = new Map<string, ArchiveScanCacheEntry>();

/** Manifests are append-only per run, so identity is the sorted path list with mtime and size. */
function archiveScanSignature(manifestPaths: readonly string[]): string {
  return manifestPaths
    .map((manifestPath) => {
      const stat = statSync(manifestPath, { throwIfNoEntry: false });
      return stat ? `${manifestPath}\u0000${stat.mtimeMs}\u0000${stat.size}` : manifestPath;
    })
    .join("\u0001");
}

function scanArchivedSources(
  target: SessionSqliteMigrationTargetInput,
  manifestPaths: readonly string[],
  retainedOnly: boolean,
): ArchivedSessionSources {
  const archives: ArchivedSessionSources = new Map();
  for (const manifestPath of manifestPaths) {
    const manifest = readSessionSqliteMigrationManifest(manifestPath);
    const targets = manifest ? filterRestoreManifestTargets(manifest, [target]) : [];
    for (const candidate of targets) {
      for (const move of candidate.plannedMoves) {
        if (move.artifact && (!retainedOnly || move.artifact.disposal.state !== "disposed")) {
          const paths = archives.get(move.sourcePath) ?? [];
          paths.push({
            path: move.archivePath,
            identity: move.artifact.identity,
            dependencies: move.artifact.dependencies,
          });
          archives.set(move.sourcePath, paths);
        }
      }
    }
  }
  return archives;
}

/** Doctor verification and cleanup consume the same manifest source custody. */
export function collectArchivedSources(
  target: SessionSqliteMigrationTargetInput,
  env: NodeJS.ProcessEnv,
  retainedOnly = false,
): ArchivedSessionSources {
  const manifestPaths = listSessionSqliteMigrationManifestPaths(env);
  // Runs directory, full target and filter shape decide the answer; the signature says
  // whether the recorded manifests still describe it. Store path alone is not the target:
  // the restore filter also matches on the selected SQLite path.
  const cacheKey = [
    resolveSessionSqliteMigrationRunsDir(env),
    sessionSqliteMigrationTargetKey(target),
    canonicalMigrationFilePath(target.sqlitePath),
    retainedOnly ? "retained" : "all",
  ].join("\u0001");
  const signature = archiveScanSignature(manifestPaths);
  const cached = archiveScanCache.get(cacheKey);
  if (cached?.signature === signature) {
    return cached.archives;
  }
  const archives = scanArchivedSources(target, manifestPaths, retainedOnly);
  archiveScanCache.delete(cacheKey);
  archiveScanCache.set(cacheKey, { signature, archives });
  if (archiveScanCache.size > ARCHIVE_SCAN_CACHE_LIMIT) {
    const oldestKey = archiveScanCache.keys().next();
    if (!oldestKey.done) {
      archiveScanCache.delete(oldestKey.value);
    }
  }
  return archives;
}

export function existingSessionSourcePaths(
  sourcePath: string,
  archives: ArchivedSessionSources,
): string[] {
  return statMigrationPath(sourcePath)
    ? [sourcePath]
    : (archives.get(sourcePath) ?? [])
        .map((source) => source.path)
        .filter((source) => statMigrationPath(source));
}
