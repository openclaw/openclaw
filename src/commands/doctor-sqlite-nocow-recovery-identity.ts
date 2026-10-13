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
 * A record is refreshed only when the file being rewritten is the exact generation the manifest
 * recorded: its pre-exchange device/inode must still equal the recorded identity. This keeps the
 * destination binding intact — a valid database that merely replaced the recorded pathname is not
 * adopted. For a recovery original the rewrite's own copy is additionally required to carry the
 * recorded content (`size` and `sha256`); a destination database relies on the rewrite's verified
 * WAL-aware snapshot and integrity check. Anything that cannot be proven is left untouched and
 * reported, so cleanup stays conservative rather than weakened.
 */
export function reconcileNoCowRecoveryIdentities(params: {
  env: NodeJS.ProcessEnv;
  previousIdentities: ReadonlyMap<string, Pick<fs.BigIntStats, "dev" | "ino">>;
  assertCurrent: () => void;
}): string[] {
  const previous = new Map<string, { dev: string; ino: string }>();
  for (const [pathname, stat] of params.previousIdentities) {
    previous.set(canonicalMigrationFilePath(pathname), {
      dev: String(stat.dev),
      ino: String(stat.ino),
    });
  }
  if (previous.size === 0) {
    return [];
  }
  const warnings: string[] = [];
  const matchesRecordedGeneration = (pathname: string, dev: string, ino: string) => {
    const pre = previous.get(canonicalMigrationFilePath(pathname));
    return pre !== undefined && pre.dev === dev && pre.ino === ino;
  };
  for (const manifestPath of listSessionSqliteMigrationManifestPaths(params.env)) {
    const manifest = readSessionSqliteMigrationManifest(manifestPath);
    if (!manifest) {
      continue;
    }
    let changed = false;
    for (const target of manifest.targets) {
      for (const move of [...target.completedMoves, ...target.plannedMoves]) {
        const artifact = move.artifact;
        if (!artifact || !previous.has(canonicalMigrationFilePath(move.archivePath))) {
          continue;
        }
        if (
          !matchesRecordedGeneration(move.archivePath, artifact.identity.dev, artifact.identity.ino)
        ) {
          warnings.push(
            `NOCOW recovery identity left unchanged for ${move.archivePath}: the rewritten file is not the recorded generation`,
          );
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
      const databaseIdentity = target.databaseIdentity;
      if (!databaseIdentity || !previous.has(canonicalMigrationFilePath(target.sqlitePath))) {
        continue;
      }
      if (
        !matchesRecordedGeneration(target.sqlitePath, databaseIdentity.dev, databaseIdentity.ino)
      ) {
        warnings.push(
          `NOCOW destination identity left unchanged for ${target.sqlitePath}: the rewritten database is not the recorded destination`,
        );
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
