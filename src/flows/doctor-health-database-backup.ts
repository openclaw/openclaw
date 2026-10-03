import fs from "node:fs";
import type { BackupSqliteSnapshotFact } from "../commands/backup-resource-inventory.js";
import type { DoctorDatabasePreflight } from "../commands/doctor-database-preflight.js";
import type { RuntimeEnv } from "../runtime.js";

/** Prepare backup coverage inside the caller's already admitted Doctor maintenance scope. */
export async function prepareDoctorHealthDatabaseBackups(params: {
  schemas: DoctorDatabasePreflight;
  automaticHeartbeatRepair: boolean;
  verifiedSnapshots: readonly BackupSqliteSnapshotFact[];
  runtime: Pick<RuntimeEnv, "log">;
}): Promise<DoctorDatabasePreflight> {
  let schemas = params.schemas;
  if (!params.automaticHeartbeatRepair) {
    const {
      repairOpenClawStateDatabaseIndexesForDoctor,
      repairOpenClawStateDatabaseReadabilityForDoctor,
    } = await import("../state/openclaw-state-db.js");
    // Restore physical indexes, then legacy catalog readability before config discovery.
    let repairedState = false;
    for (const repair of [
      repairOpenClawStateDatabaseIndexesForDoctor,
      repairOpenClawStateDatabaseReadabilityForDoctor,
    ]) {
      const result = repair({ env: process.env });
      repairedState ||= result.changes.length > 0;
      if (result.warnings.length > 0) {
        throw new Error(result.warnings.join("\n"));
      }
      for (const change of result.changes) {
        params.runtime.log(change);
      }
    }
    if (repairedState) {
      const { prepareDoctorDatabasePreflight } =
        await import("../commands/doctor-database-preflight.js");
      schemas = await prepareDoctorDatabasePreflight();
    }
  }
  const { backupDoctorMigrationDatabases } = await import("../commands/doctor-migration-backup.js");
  const { createOpenClawAgentDatabasePathMatcher } =
    await import("../state/openclaw-agent-db.paths.js");
  const { resolveOpenClawStateSqlitePath } = await import("../state/openclaw-state-db.paths.js");
  const { normalizeAgentId } = await import("../routing/session-key.js");
  const samePath = createOpenClawAgentDatabasePathMatcher();
  const discovery = schemas.agentDatabaseMigrationDiscovery?.discovery;
  const databasePaths = discovery?.targets
    .filter(
      (database) =>
        !schemas.agentRefusals?.some(
          (refusal) =>
            normalizeAgentId(refusal.agentId) === normalizeAgentId(database.agentId) &&
            refusal.paths.some((pathname) => samePath(pathname, database.path)),
        ) &&
        !schemas.indeterminate.some(
          (failure) =>
            failure.kind === "agent" &&
            (failure.path === database.path ||
              discovery.sourceIdentities.get(failure.path)?.realPath === database.realPath),
        ),
    )
    .map((database) => database.path);
  const backups = await backupDoctorMigrationDatabases({
    env: process.env,
    databasePaths: databasePaths ?? [],
    pendingDatabasePaths: [
      ...(schemas.pendingMigrations?.map((database) => database.path) ?? []),
      ...(params.automaticHeartbeatRepair
        ? [resolveOpenClawStateSqlitePath(), ...(databasePaths ?? [])].filter((pathname) =>
            fs.existsSync(pathname),
          )
        : []),
    ],
    verifiedSnapshots: params.verifiedSnapshots,
  });
  for (const change of backups.changes) {
    params.runtime.log(change);
  }
  for (const warning of backups.warnings) {
    params.runtime.log(warning);
  }
  return schemas;
}
