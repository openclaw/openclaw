import { existsSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { CronStoreSelectionRequiredError } from "../cron/store/selection-error.js";
import type { DoctorProgressMeasure } from "../infra/doctor-progress.js";
import type { ExistingAgentDatabaseTarget } from "../infra/session-sqlite-migration-readers.js";
import type { AgentDatabaseMigrationTarget } from "../infra/state-migrations.media-persistence-targets.js";
import { hasUpdateDoctorMigrationCapture } from "../infra/update-doctor-migration-context.js";
import type { RuntimeEnv } from "../runtime.js";
import { isArtifactPreservingStateRead } from "../state/artifact-preserving-state-reads.js";
import { agentEngineInput } from "../state/openclaw-agent-db-engine.js";
import { stateEngineInput } from "../state/openclaw-state-db-engine-input.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import type { BackupSqliteSnapshotFact } from "./backup-resource-inventory.js";
import type { DoctorDatabasePreflight } from "./doctor-database-preflight.js";
import { decideDoctorPendingFromLiveStores } from "./doctor-live-store-pending.js";
import type { DoctorMaintenancePending } from "./doctor-maintenance-pending.js";
import {
  backupDoctorMigrationDatabases,
  needsSharedStateMigrationBackup,
} from "./doctor-migration-backup.js";

/** Version migrations settle before retirement captures its same-schema rollback group. */
export async function prepareDoctorMigrationBackups(params: {
  schemas: DoctorDatabasePreflight;
  env: NodeJS.ProcessEnv;
  check: "quick" | "full";
  verifiedSnapshots: readonly BackupSqliteSnapshotFact[];
  automaticRepair: boolean;
  runtime: Pick<RuntimeEnv, "log">;
  measure: DoctorProgressMeasure;
}) {
  const { schemas, env, check, verifiedSnapshots, automaticRepair, runtime, measure } = params;
  const { prepareDoctorDatabaseMigrations } = await import("./doctor-schema-migrations.js");
  const databaseTargets = await resolveMigrationDatabaseTargets(schemas);
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

/** Agent stores Doctor may migrate: discovered, and neither refused nor indeterminate. */
async function resolveMigrationDatabaseTargets(schemas: DoctorDatabasePreflight) {
  const { createOpenClawAgentDatabasePathMatcher } =
    await import("../state/openclaw-agent-db.paths.js");
  const { normalizeAgentId } = await import("../routing/session-key.js");
  const samePath = createOpenClawAgentDatabasePathMatcher();
  const discovery = schemas.agentDatabaseMigrationDiscovery?.discovery;
  return discovery?.schemaTargets.filter(
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
}

/**
 * Read-only: whether {@link prepareDoctorMigrationBackups} would migrate or back up a
 * store. It reuses the step's gates on the prepared preflight: a pending version
 * migration, a refused or indeterminate store, a shared state database whose schema
 * needs repair, an automatic heartbeat repair, and pending heartbeat retirement.
 * It reads the live stores, never a copy, so it is undecidable under an updater's
 * migration capture (which always adds agent schemas) or an artifact-preserving read,
 * and for a store no connection holds open (the read would create its WAL sidecars).
 */
export async function checkDoctorDatabaseMigrationsPending(params: {
  schemas: DoctorDatabasePreflight;
  env: NodeJS.ProcessEnv;
  automaticRepair: boolean;
}): Promise<DoctorMaintenancePending> {
  const { schemas, env } = params;
  if (hasUpdateDoctorMigrationCapture() || isArtifactPreservingStateRead()) {
    return "undecidable";
  }
  if (hasUnpreparedSchemas(schemas, undefined) || params.automaticRepair) {
    return "work";
  }
  const sharedPath = resolveOpenClawStateSqlitePath(env);
  const targets = await resolveMigrationDatabaseTargets(schemas);
  // The step's artifact-preserving reads see the same bytes, copied.
  return decideDoctorPendingFromLiveStores(
    [sharedPath, ...(targets?.map((target) => target.path) ?? [])],
    async () =>
      (await needsSharedStateMigrationBackup(sharedPath)) ||
      (await needsHeartbeatMigrationBackup({
        env,
        agentDatabaseTargets: targets,
        automaticRepair: false,
        schemaPreparationPending: false,
      }))
        ? "work"
        : "none",
  );
}

/**
 * Report stores that canonical readers still cannot open. The version phase commits
 * every migration it returns, so those stores are current and need no conservative
 * full backup; refused, unreadable, or unmigrated stores still do.
 */
function hasUnpreparedSchemas(
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
        (await hasPendingHeartbeatCadenceMigration(sourceConfig, env)) ||
        (await collectHeartbeatScratchMigrationFindings(sourceConfig, env)).length > 0 ||
        (await hasPendingHeartbeatOutcomes(targets, env))),
    );
  } catch (error) {
    // Selection may unlock legacy heartbeat work later; preserve its full rollback group.
    if (error instanceof CronStoreSelectionRequiredError) {
      return true;
    }
    throw error;
  }
}

/** Older or refused stores cannot use canonical readers before schema repair. */
async function needsHeartbeatMigrationBackup(params: {
  env: NodeJS.ProcessEnv;
  agentDatabaseTargets?: readonly AgentDatabaseMigrationTarget[];
  automaticRepair: boolean;
  schemaPreparationPending: boolean;
}): Promise<boolean> {
  return (
    params.schemaPreparationPending ||
    params.automaticRepair ||
    (await hasPendingHeartbeatMigration(
      params.agentDatabaseTargets?.map((database) => ({
        agentId: database.agentId,
        storePath: database.path,
        sqlitePath: database.path,
      })) ?? [],
      params.env,
    ))
  );
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
  if (!(await needsHeartbeatMigrationBackup(params))) {
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
