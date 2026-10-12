/** Re-record recovery-artifact identities that Doctor's verified NOCOW rewrite relocated. */
import fs from "node:fs";
import { readMigrationArtifactIdentity } from "../infra/session-sqlite-migration-artifact.js";
import {
  canonicalMigrationFilePath,
  listSessionSqliteMigrationManifestPaths,
  readSessionSqliteMigrationManifest,
  writeSessionSqliteMigrationManifest,
} from "../infra/session-sqlite-migration-manifest.js";

/**
 * The NOCOW rewrite replaces every store file with a byte-for-byte copy in a fresh directory,
 * so the inode and mtime recorded in the migration manifest no longer match the live file.
 * Doctor owns both the rewrite and the manifest, so after a verified rewrite it re-records the
 * new identity for the recovery originals and destination databases it relocated.
 *
 * An artifact is re-recorded only when the rewritten copy still carries the recorded content
 * (`size` and `sha256`), and the destination database only after the rewrite's own WAL-aware
 * snapshot and integrity verification established the replacement. Anything that cannot be
 * proven is left untouched and reported, so cleanup stays conservative rather than weakened.
 */
export function reconcileNoCowRecoveryIdentities(params: {
  env: NodeJS.ProcessEnv;
  rewrittenPaths: readonly string[];
  assertCurrent: () => void;
}): string[] {
  const rewritten = new Set(params.rewrittenPaths.map(canonicalMigrationFilePath));
  if (rewritten.size === 0) {
    return [];
  }
  const warnings: string[] = [];
  for (const manifestPath of listSessionSqliteMigrationManifestPaths(params.env)) {
    const manifest = readSessionSqliteMigrationManifest(manifestPath);
    if (!manifest) {
      continue;
    }
    let changed = false;
    for (const target of manifest.targets) {
      for (const move of [...target.completedMoves, ...target.plannedMoves]) {
        const artifact = move.artifact;
        if (!artifact || !rewritten.has(canonicalMigrationFilePath(move.archivePath))) {
          continue;
        }
        try {
          params.assertCurrent();
          const next = readMigrationArtifactIdentity(move.archivePath);
          if (next.size !== artifact.identity.size || next.sha256 !== artifact.identity.sha256) {
            throw new Error("rewritten copy no longer matches the recorded content");
          }
          artifact.identity = {
            ...artifact.identity,
            dev: next.dev,
            ino: next.ino,
            mtimeNs: next.mtimeNs,
          };
          changed = true;
        } catch (error) {
          warnings.push(
            `NOCOW recovery identity left unchanged for ${move.archivePath}: ${String(error)}`,
          );
        }
      }
      if (
        !target.databaseIdentity ||
        !rewritten.has(canonicalMigrationFilePath(target.sqlitePath))
      ) {
        continue;
      }
      try {
        params.assertCurrent();
        const next = fs.lstatSync(target.sqlitePath, { bigint: true });
        if (!next.isFile() || next.nlink !== 1n) {
          throw new Error("rewritten database is not an unaliased regular file");
        }
        target.databaseIdentity = { dev: String(next.dev), ino: String(next.ino) };
        changed = true;
      } catch (error) {
        warnings.push(
          `NOCOW destination identity left unchanged for ${target.sqlitePath}: ${String(error)}`,
        );
      }
    }
    if (changed) {
      params.assertCurrent();
      writeSessionSqliteMigrationManifest({ manifest, manifestPath });
    }
  }
  return warnings;
}
