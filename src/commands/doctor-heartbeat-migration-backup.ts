import { existsSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import type { ConfigSnapshotReadMeasure } from "../config/io.read.types.js";
import { CronStoreSelectionRequiredError } from "../cron/store/selection-error.js";
import type { ExistingAgentDatabaseTarget } from "../infra/session-sqlite-migration-readers.js";
import type { RuntimeEnv } from "../runtime.js";
import { agentEngineInput } from "../state/openclaw-agent-db-engine.js";
import { stateEngineInput } from "../state/openclaw-state-db-engine.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import type { BackupSqliteSnapshotFact } from "./backup-resource-inventory.js";
import type { DoctorDatabasePreflight } from "./doctor-database-preflight.js";
import { backupDoctorMigrationDatabases } from "./doctor-migration-backup.js";

/** Version migrations settle before retirement captures its same-schema rollback group. */
export async function prepareDoctorMigrationBackups(params: {
  schemas: DoctorDatabasePreflight;
  env: NodeJS.ProcessEnv;
  check: "quick" | "full";
  verifiedSnapshots: readonly BackupSqliteSnapshotFact[];
  automaticRepair: boolean;
  runtime: Pick<RuntimeEnv, "log">;
  measure: ConfigSnapshotReadMeasure;
}) {
  const { schemas, env, check, verifiedSnapshots, automaticRepair, runtime, measure } = params;
  const { prepareDoctorDatabaseMigrations } = await import("./doctor-schema-migrations.js");
  const { createOpenClawAgentDatabasePathMatcher } =
    await import("../state/openclaw-agent-db.paths.js");
  const { normalizeAgentId } = await import("../routing/session-key.js");
  const samePath = createOpenClawAgentDatabasePathMatcher();
  const discovery = schemas.agentDatabaseMigrationDiscovery?.discovery;
  const databaseTargets = discovery?.schemaTargets.filter(
    ({ agentId, path: databasePath, realPath }) =>
      !schemas.agentRefusals?.some(
        (refusal) =>
          normalizeAgentId(refusal.agentId) === normalizeAgentId(agentId) &&
          refusal.paths.some((pathname) => samePath(pathname, databasePath)),
      ) &&
      !schemas.indeterminate.some(
        (failure) =>
          failure.kind === "agent" &&
          (failure.path === databasePath ||
            discovery.sourceIdentities.get(failure.path)?.realPath === realPath),
      ),
  );
  const backups = await measure("doctor.database-migrations", () =>
    prepareDoctorDatabaseMigrations({
      env,
      check,
      databasePaths: databaseTargets?.map((database) => database.path) ?? [],
      agentDatabaseTargets: databaseTargets,
      pendingDatabasePaths: schemas.pendingMigrations?.map((database) => database.path) ?? [],
      pendingMigrations: schemas.pendingMigrations,
      verifiedSnapshots,
    }),
  );
  for (const message of [...backups.changes, ...backups.warnings]) {
    runtime.log(message);
  }
  if (schemas.agentDatabaseMigrationDiscovery && backups.versionMigrations) {
    schemas.agentDatabaseMigrationDiscovery.versionMigrations = backups.versionMigrations;
  }
  const heartbeatBackups = await measure("doctor.heartbeat-migration-backups", () =>
    backupHeartbeatMigrationDatabases({
      env,
      check,
      databasePaths: databaseTargets?.map((database) => database.path) ?? [],
      agentDatabaseTargets: databaseTargets,
      verifiedSnapshots,
      automaticRepair,
      schemaPreparationPending: hasUnpreparedSchemas(schemas, backups.versionMigrations),
    }),
  );
  for (const message of [...heartbeatBackups.changes, ...heartbeatBackups.warnings]) {
    runtime.log(message);
  }
}

/**
 * Report stores that canonical readers still cannot open. The version phase commits
 * every migration it returns, so those stores are current and need no conservative
 * full backup; refused, unreadable, or unmigrated stores still do.
 */
export function hasUnpreparedSchemas(
  schemas: Pick<DoctorDatabasePreflight, "pendingMigrations" | "agentRefusals" | "indeterminate">,
  committedVersionMigrations: readonly { path: string }[] | undefined,
): boolean {
  const committed = new Set(committedVersionMigrations?.map((migration) => migration.path));
  return (
    Boolean(schemas.pendingMigrations?.some((migration) => !committed.has(migration.path))) ||
    Boolean(schemas.agentRefusals?.length) ||
    schemas.indeterminate.length > 0
  );
}

async function hasPendingHeartbeatMigration(
  targets: readonly ExistingAgentDatabaseTarget[],
  env: NodeJS.ProcessEnv,
): Promise<boolean> {
  const [
    { createConfigIO },
    { tryProjectRetiredHeartbeatConfig },
    { hasPendingHeartbeatCadenceMigration },
    { collectHeartbeatScratchMigrationFindings },
    { hasPendingHeartbeatOutcomes },
  ] = await Promise.all([
    import("../config/io.factory.js"),
    import("./doctor-heartbeat-legacy.js"),
    import("./doctor-heartbeat-cadence-migration.js"),
    import("./doctor-heartbeat-scratch-migration.js"),
    import("./doctor-heartbeat-outcome-migration.js"),
  ]);
  const { sourceConfig } = await createConfigIO({
    env,
    observe: false,
    pluginValidation: "core-only",
  }).readConfigFileSnapshot();
  const projected = tryProjectRetiredHeartbeatConfig(sourceConfig);
  try {
    return Boolean(
      projected &&
      (!isDeepStrictEqual(projected, sourceConfig) ||
        hasPendingHeartbeatCadenceMigration(sourceConfig, env) ||
        (await collectHeartbeatScratchMigrationFindings(sourceConfig, env)).length > 0 ||
        hasPendingHeartbeatOutcomes(targets, env)),
    );
  } catch (error) {
    // Selection may unlock legacy heartbeat work later; preserve its full rollback group.
    if (error instanceof CronStoreSelectionRequiredError) {
      return true;
    }
    throw error;
  }
}

/** Heartbeat retirement changes current-schema data too; preserve the complete rollback group. */
async function backupHeartbeatMigrationDatabases(
  params: Omit<
    Parameters<typeof backupDoctorMigrationDatabases>[0],
    "pendingDatabasePaths" | "pendingMigrations" | "versionMigrationsOnly"
  > & {
    automaticRepair: boolean;
    schemaPreparationPending: boolean;
  },
) {
  // Older or refused stores cannot use canonical readers before schema repair.
  if (
    !params.schemaPreparationPending &&
    !params.automaticRepair &&
    !(await hasPendingHeartbeatMigration(
      params.agentDatabaseTargets?.map((database) => ({
        agentId: database.agentId,
        storePath: database.path,
        sqlitePath: database.path,
      })) ?? [],
      params.env,
    ))
  ) {
    return { changes: [], warnings: [] };
  }
  const sharedPath = resolveOpenClawStateSqlitePath(params.env);
  return backupDoctorMigrationDatabases({
    env: params.env,
    check: params.check,
    databasePaths: params.databasePaths,
    agentDatabaseTargets: params.agentDatabaseTargets,
    verifiedSnapshots: params.verifiedSnapshots,
    pendingDatabasePaths: [sharedPath, ...params.databasePaths].filter(
      (pathname) =>
        existsSync(pathname) ||
        Boolean(pathname === sharedPath ? stateEngineInput() : agentEngineInput()),
    ),
  });
}
