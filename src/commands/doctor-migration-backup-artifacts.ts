import fs from "node:fs";
import path from "node:path";
import {
  readMigrationArtifactIdentity,
  type MigrationArtifactVerification,
} from "../infra/session-sqlite-migration-artifact.js";
import {
  canonicalMigrationFilePath,
  hasSymbolicLinkInDirectoryPath,
  listSessionSqliteMigrationManifestPaths,
  readSessionSqliteMigrationManifest,
  resolveSessionSqliteMigrationRunsDir,
  writeSessionSqliteMigrationManifest,
  type SessionSqliteMigrationTargetManifest,
} from "../infra/session-sqlite-migration-manifest.js";
import { UPDATE_RUN_ID_PATTERN } from "../infra/update-displaced-database-receipt.js";
import { getUpdateRun } from "../infra/update-run-reader.js";
import { getOpenClawDatabaseMaintenanceScope } from "../state/openclaw-state-db-async-lifecycle.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { VERSION } from "../version.js";
import type { DoctorMaintenancePending } from "./doctor-maintenance-pending.js";

/** Record the producer's verified originals in the existing recovery inventory. */
export function recordDoctorMigrationBackups(
  env: NodeJS.ProcessEnv,
  backupId: string,
  inventory: readonly { path: string; identity: fs.BigIntStats; archivePath: string }[],
  versionPhase = false,
  verification?: MigrationArtifactVerification,
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
    ({ path: source, identity, archivePath }) => {
      const move = {
        kind: "database-backup" as const,
        sourcePath: source,
        archivePath,
        artifact: {
          identity: readMigrationArtifactIdentity(archivePath, 1n, undefined, verification),
          classification: "repair-original" as const,
          reason: versionPhase ? "pre-version-migration-backup" : "pre-startup-migration-backup",
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
  // Inside an update this links the backups to the run whose outcome releases them.
  // UPDATE_RUN_ID_ENV; spelled out so Doctor does not load the update control plane. Only a
  // run still in progress owns these backups; a stale variable leaves them untagged.
  const candidateRunId = env.OPENCLAW_UPDATE_RUN_ID?.trim();
  let updateRunId: string | undefined;
  if (candidateRunId && UPDATE_RUN_ID_PATTERN.test(candidateRunId)) {
    try {
      const run = getUpdateRun(candidateRunId, { env });
      updateRunId =
        run?.status === "running" && run.finishedAtMs === null ? candidateRunId : undefined;
    } catch {
      updateRunId = undefined;
    }
  }
  getOpenClawDatabaseMaintenanceScope()?.assertAdmission();
  writeSessionSqliteMigrationManifest({
    manifestPath,
    manifest: {
      manifestVersion: 3,
      runId,
      openClawVersion: VERSION,
      startedAt: new Date().toISOString(),
      targets,
      ...(updateRunId ? { updateRunId } : {}),
    },
  });
}

/** Incomplete backup manifests whose every target is a verified, unchanged database. */
function* listCompletableDoctorMigrationBackups(
  env: NodeJS.ProcessEnv,
  verifiedDatabasePaths: readonly string[],
  versionPhaseOnly: boolean,
) {
  const verified = new Set(
    [...verifiedDatabasePaths, resolveOpenClawStateSqlitePath(env)].map(canonicalMigrationFilePath),
  );
  for (const manifestPath of listSessionSqliteMigrationManifestPaths(env)) {
    const manifest = readSessionSqliteMigrationManifest(manifestPath);
    if (
      !manifest ||
      manifest.completedAt ||
      !manifest.targets.length ||
      (versionPhaseOnly &&
        !manifest.targets.every((target) =>
          target.completedMoves.every(
            (move) => move.artifact?.reason === "pre-version-migration-backup",
          ),
        )) ||
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
    yield { manifest, manifestPath };
  }
}

/**
 * Read-only: whether `completeDoctorMigrationBackups` would record a completion for these
 * databases. Callers pass every candidate path; refusals found later only narrow the set.
 */
export function checkDoctorMigrationBackupsPending(
  env: NodeJS.ProcessEnv,
  databasePaths: readonly string[],
): DoctorMaintenancePending {
  if (!getOpenClawDatabaseMaintenanceScope()?.ownsSchemaMaintenance) {
    return "none";
  }
  return listCompletableDoctorMigrationBackups(env, databasePaths, false).next().done
    ? "none"
    : "work";
}

/** Complete a committed version phase, or the full Doctor phase for undeclared migrations. */
export function completeDoctorMigrationBackups(
  env: NodeJS.ProcessEnv,
  verifiedDatabasePaths: readonly string[],
  versionPhaseOnly = false,
): void {
  const maintenance = getOpenClawDatabaseMaintenanceScope();
  if (!maintenance?.ownsSchemaMaintenance) {
    return;
  }
  for (const { manifest, manifestPath } of listCompletableDoctorMigrationBackups(
    env,
    verifiedDatabasePaths,
    versionPhaseOnly,
  )) {
    maintenance.assertAdmission();
    for (const target of manifest.targets) {
      target.validationBeforeArchive = "passed";
    }
    manifest.completedAt = new Date().toISOString();
    writeSessionSqliteMigrationManifest({ manifest, manifestPath });
  }
}
