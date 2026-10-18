import fs from "node:fs";
import path from "node:path";
import { readMigrationArtifactIdentity } from "../infra/session-sqlite-migration-artifact.js";
import {
  canonicalMigrationFilePath,
  hasSymbolicLinkInDirectoryPath,
  listSessionSqliteMigrationManifestPaths,
  readSessionSqliteMigrationManifest,
  resolveSessionSqliteMigrationRunsDir,
  writeSessionSqliteMigrationManifest,
  type SessionSqliteMigrationTargetManifest,
} from "../infra/session-sqlite-migration-manifest.js";
import { getOpenClawDatabaseMaintenanceScope } from "../state/openclaw-state-db-async-lifecycle.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { VERSION } from "../version.js";

/** Record the producer's verified originals in the existing recovery inventory. */
export function recordDoctorMigrationBackups(
  env: NodeJS.ProcessEnv,
  backupId: string,
  inventory: readonly { path: string; identity: fs.BigIntStats }[],
): void {
  const runId = `startup-migration-${backupId}`;
  const manifestPath = path.join(resolveSessionSqliteMigrationRunsDir(env), `${runId}.json`);
  if (hasSymbolicLinkInDirectoryPath(path.dirname(manifestPath))) {
    throw new Error("Migration backup manifest directory is aliased");
  }
  if (fs.existsSync(manifestPath)) {
    if (!readSessionSqliteMigrationManifest(manifestPath)) {
      throw new Error(`Cannot read migration backup manifest: ${manifestPath}`);
    }
    return;
  }
  const targets: SessionSqliteMigrationTargetManifest[] = inventory.map(
    ({ path: source, identity }) => {
      const archivePath = `${source}.pre-startup-migration-${backupId}.bak`;
      const move = {
        kind: "database-backup" as const,
        sourcePath: source,
        archivePath,
        artifact: {
          identity: readMigrationArtifactIdentity(archivePath),
          classification: "repair-original" as const,
          reason: "pre-startup-migration-backup",
          dependencies: [],
          disposal: { state: "retained" as const },
        },
      };
      return {
        agentId: "startup-migration",
        storePath: source,
        sqlitePath: source,
        databaseIdentity: { dev: String(identity.dev), ino: String(identity.ino) },
        plannedMoves: [move],
        completedMoves: [move],
        issues: [],
        validationBeforeArchive: "not_run",
      };
    },
  );
  getOpenClawDatabaseMaintenanceScope()?.assertAdmission();
  writeSessionSqliteMigrationManifest({
    manifestPath,
    manifest: {
      manifestVersion: 3,
      runId,
      openClawVersion: VERSION,
      startedAt: new Date().toISOString(),
      targets,
    },
  });
}

/** Called only after Doctor's database readiness owner verifies the whole fleet. */
export function completeDoctorMigrationBackups(
  env: NodeJS.ProcessEnv,
  verifiedDatabasePaths: readonly string[],
): void {
  const maintenance = getOpenClawDatabaseMaintenanceScope();
  if (!maintenance?.ownsSchemaMaintenance) {
    return;
  }
  const verified = new Set(
    [...verifiedDatabasePaths, resolveOpenClawStateSqlitePath(env)].map(canonicalMigrationFilePath),
  );
  for (const manifestPath of listSessionSqliteMigrationManifestPaths(env)) {
    const manifest = readSessionSqliteMigrationManifest(manifestPath);
    if (
      !manifest ||
      manifest.completedAt ||
      !manifest.targets.length ||
      !manifest.targets.every(({ databaseIdentity, sqlitePath }) => {
        if (!databaseIdentity || !verified.has(sqlitePath)) {
          return false;
        }
        const current = fs.lstatSync(sqlitePath, { bigint: true, throwIfNoEntry: false });
        return (
          current?.isFile() &&
          current.nlink === 1n &&
          String(current.dev) === databaseIdentity.dev &&
          String(current.ino) === databaseIdentity.ino
        );
      })
    ) {
      continue;
    }
    maintenance.assertAdmission();
    for (const target of manifest.targets) {
      target.validationBeforeArchive = "passed";
    }
    manifest.completedAt = new Date().toISOString();
    writeSessionSqliteMigrationManifest({ manifest, manifestPath });
  }
}
