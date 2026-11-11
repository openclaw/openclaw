import fs from "node:fs";
import { rebindRewrittenClientCredentials } from "../infra/client-credential-restore.js";
import {
  canonicalMigrationFilePath,
  listSessionSqliteMigrationManifestPaths,
  readSessionSqliteMigrationManifest,
  writeSessionSqliteMigrationManifest,
} from "../infra/session-sqlite-migration-manifest.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";

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
  const sharedPath = canonicalMigrationFilePath(resolveOpenClawStateSqlitePath(params.env));
  const sharedBefore = previous.get(sharedPath);
  if (sharedBefore) {
    try {
      rebindRewrittenClientCredentials({
        env: params.env,
        previousSharedFile: {
          path: sharedPath,
          dev: String(sharedBefore.dev),
          ino: String(sharedBefore.ino),
        },
        assertCurrent: params.assertCurrent,
      });
    } catch (error) {
      warnings.push(`NOCOW credential identity left unchanged for ${sharedPath}: ${String(error)}`);
    }
  }
  const refresh = (pathname: string, identity: { dev: string; ino: string }): boolean => {
    const before = previous.get(canonicalMigrationFilePath(pathname));
    if (!before) {
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
      // The destination may have migrated in place; bind its generation, not its old bytes.
      identity.dev = String(next.dev);
      identity.ino = String(next.ino);
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
