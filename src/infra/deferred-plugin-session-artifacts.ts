import {
  statMigrationPath,
  type MigrationArtifactIdentity,
} from "./session-sqlite-migration-artifact.js";
import {
  filterRestoreManifestTargets,
  listSessionSqliteMigrationManifestPaths,
  readSessionSqliteMigrationManifest,
  type SessionSqliteMigrationTargetInput,
} from "./session-sqlite-migration-manifest.js";

export type ArchivedSessionSources = Map<
  string,
  Array<{ identity: MigrationArtifactIdentity; path: string; dependencies: readonly string[] }>
>;

/** Doctor verification and cleanup consume the same manifest source custody. */
export function collectArchivedSources(
  target: SessionSqliteMigrationTargetInput,
  env: NodeJS.ProcessEnv,
  retainedOnly = false,
): ArchivedSessionSources {
  const archives: ArchivedSessionSources = new Map();
  for (const manifestPath of listSessionSqliteMigrationManifestPaths(env)) {
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

export function existingSessionSourcePaths(
  sourcePath: string,
  target: SessionSqliteMigrationTargetInput,
  env: NodeJS.ProcessEnv,
  archives?: ArchivedSessionSources,
): string[] {
  return statMigrationPath(sourcePath)
    ? [sourcePath]
    : ((archives ?? collectArchivedSources(target, env)).get(sourcePath) ?? [])
        .map((source) => source.path)
        .filter((source) => statMigrationPath(source));
}
