import fs from "node:fs";
import {
  readMigrationArtifactIdentity,
  type MigrationArtifact,
} from "../infra/session-sqlite-migration-artifact.js";
import {
  canonicalMigrationFilePath,
  listSessionSqliteMigrationManifestPaths,
  readSessionSqliteMigrationManifest,
  writeSessionSqliteMigrationManifest,
} from "../infra/session-sqlite-migration-manifest.js";

/** Transfer existing recovery evidence only across Doctor's verified offline rewrite. */
export function reconcileNoCowRecoveryIdentities(params: {
  env: NodeJS.ProcessEnv;
  previousIdentities: ReadonlyMap<string, fs.BigIntStats>;
  assertCurrent: () => void;
}): string[] {
  const previous = new Map(
    [...params.previousIdentities].map(([pathname, stat]) => [
      canonicalMigrationFilePath(pathname),
      stat,
    ]),
  );
  const warnings: string[] = [];
  const refresh = (
    pathname: string,
    identity: { dev: string; ino: string },
    artifact?: MigrationArtifact,
  ): boolean => {
    const before = previous.get(canonicalMigrationFilePath(pathname));
    if (!before || (artifact && artifact.disposal.state !== "retained")) {
      return false;
    }
    try {
      if (String(before.dev) !== identity.dev || String(before.ino) !== identity.ino) {
        throw new Error("rewritten file is not the recorded generation");
      }
      params.assertCurrent();
      const next = fs.lstatSync(pathname, { bigint: true });
      if (!next.isFile() || next.nlink !== 1n) {
        throw new Error("rewritten file is not an unaliased regular file");
      }
      if (artifact) {
        const copied = readMigrationArtifactIdentity(pathname);
        if (
          String(before.mtimeNs) !== artifact.identity.mtimeNs ||
          Number(before.size) !== artifact.identity.size ||
          copied.size !== artifact.identity.size ||
          copied.sha256 !== artifact.identity.sha256
        ) {
          throw new Error("rewritten copy does not match the recorded original");
        }
        artifact.identity = copied;
      } else {
        // The destination may have migrated in place; bind its generation, not its old bytes.
        identity.dev = String(next.dev);
        identity.ino = String(next.ino);
      }
      return true;
    } catch (error) {
      warnings.push(`NOCOW recovery identity left unchanged for ${pathname}: ${String(error)}`);
      return false;
    }
  };
  for (const manifestPath of listSessionSqliteMigrationManifestPaths(params.env)) {
    const manifest = readSessionSqliteMigrationManifest(manifestPath);
    if (!manifest) {
      continue;
    }
    let changed = false;
    for (const target of manifest.targets) {
      for (const move of [...target.completedMoves, ...target.plannedMoves]) {
        if (move.artifact) {
          changed = refresh(move.archivePath, move.artifact.identity, move.artifact) || changed;
        }
      }
      if (target.databaseIdentity) {
        changed = refresh(target.sqlitePath, target.databaseIdentity) || changed;
      }
    }
    if (changed) {
      params.assertCurrent();
      writeSessionSqliteMigrationManifest({ manifest, manifestPath });
    }
  }
  return warnings;
}
