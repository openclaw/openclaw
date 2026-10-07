import fs from "node:fs";
import { isDeepStrictEqual } from "node:util";
import type { BackupSqliteSnapshotFact } from "../commands/backup-resource-inventory.js";
import type { DoctorDatabasePreflight } from "../commands/doctor-database-preflight.js";
import type { ExistingAgentDatabaseTarget } from "../infra/session-sqlite-migration-readers.js";
import type { RuntimeEnv } from "../runtime.js";

async function hasPendingHeartbeatMigration(
  targets: readonly ExistingAgentDatabaseTarget[],
): Promise<boolean> {
  const [
    { createConfigIO },
    { tryProjectRetiredHeartbeatConfig },
    { hasPendingHeartbeatCadenceMigration },
    { collectHeartbeatScratchMigrationFindings },
    { hasPendingHeartbeatOutcomes },
  ] = await Promise.all([
    import("../config/io.factory.js"),
    import("../commands/doctor-heartbeat-legacy.js"),
    import("../commands/doctor-heartbeat-cadence-migration.js"),
    import("../commands/doctor-heartbeat-scratch-migration.js"),
    import("../commands/doctor-heartbeat-outcome-migration.js"),
  ]);
  const env = process.env;
  const { sourceConfig } = await createConfigIO({
    env,
    observe: false,
    pluginValidation: "core-only",
  }).readConfigFileSnapshot();
  const projected = tryProjectRetiredHeartbeatConfig(sourceConfig);
  if (!projected) {
    return false;
  }
  return (
    !isDeepStrictEqual(projected, sourceConfig) ||
    hasPendingHeartbeatCadenceMigration(sourceConfig, env) ||
    (await collectHeartbeatScratchMigrationFindings(sourceConfig, env)).length > 0 ||
    hasPendingHeartbeatOutcomes(targets, env)
  );
}

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
  const databaseTargets = discovery?.targets.filter(
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
  );
  const databasePaths = databaseTargets?.map((database) => database.path);
  // Snapshot reuse must cover current-schema stores in the same rollback group too.
  const backupInventory =
    Boolean(schemas.pendingMigrations?.length) ||
    params.automaticHeartbeatRepair ||
    (await hasPendingHeartbeatMigration(
      databaseTargets?.map((database) => ({
        agentId: database.agentId,
        storePath: database.path,
        sqlitePath: database.path,
      })) ?? [],
    ));
  const backups = await backupDoctorMigrationDatabases({
    env: process.env,
    databasePaths: databasePaths ?? [],
    pendingDatabasePaths: [
      ...(schemas.pendingMigrations?.map((database) => database.path) ?? []),
      ...(backupInventory
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
