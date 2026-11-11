import { realpathSync } from "node:fs";
import { resolveStateDir } from "../config/paths.js";
import { withEngineStoreAdmission } from "../infra/database-engine/admission-scope.js";
import { getDatabaseEngineInput } from "../infra/database-engine/context.js";
import { isTruthyEnvValue } from "../infra/env.js";
import { formatErrorMessage } from "../infra/errors.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { isPathInside } from "../infra/path-guards.js";
import { runSqliteIntegrityOperationSync } from "../infra/sqlite-integrity.js";
import {
  inspectScopedMigrationTables,
  ScopedMigrationSnapshotUnsupportedError,
} from "../infra/sqlite-migration-scoped-snapshot.js";
import { resolveSqliteInspectionSignal } from "../infra/sqlite-readonly-worker.js";
import {
  hasUpdateDoctorMigrationCapture,
  runUpdateSqliteMigrationAsync,
} from "../infra/update-doctor-migration-attribution.js";
import { createUpdateDoctorDatabaseWriteCapture } from "../infra/update-doctor-result.js";
import { agentEngineInput, openAgentEngineStore } from "../state/openclaw-agent-db-engine.js";
import { withAgentDatabaseMaintenanceLease } from "../state/openclaw-agent-db-maintenance-lease.js";
import {
  ensureOpenClawAgentDatabaseSchemaSteps,
  ensureOpenClawAgentSchema,
} from "../state/openclaw-agent-db-schema.js";
import { isStatePostgres } from "../state/openclaw-state-db-engine.js";
import { repairDoctorStateSchemaAsync } from "../state/openclaw-state-db-repair.js";
import {
  openOpenClawStateDatabaseForDoctor,
  prepareOpenClawStateDatabaseSchema,
} from "../state/openclaw-state-db.js";
import { getOpenClawDatabaseMaintenanceScope } from "../state/openclaw-state-maintenance-context.js";
import { resolveSchemaMigrationBackupTables } from "../state/schema-migration-backup-scope.js";
import { SCHEMA_MIGRATION_BACKUP_TABLES } from "../state/schema-migration-backup-tables.js";
import type { DoctorDatabasePreflight } from "./doctor-database-preflight.js";
import { completeDoctorMigrationBackups } from "./doctor-migration-backup-artifacts.js";
import { backupDoctorMigrationDatabases } from "./doctor-migration-backup.js";
import { DOCTOR_SQLITE_NOCOW_REPAIR_ENV } from "./doctor/shared/update-phase.js";

/** Only declared migrations that leave existing data tables untouched omit rollback images. */
export function canUseDoctorScopedForwardRecovery(
  schemas: DoctorDatabasePreflight,
  env: NodeJS.ProcessEnv,
): boolean {
  if (
    !schemas.pendingMigrations?.length ||
    isTruthyEnvValue(env[DOCTOR_SQLITE_NOCOW_REPAIR_ENV]) ||
    getDatabaseEngineInput("state") ||
    getDatabaseEngineInput("agent")
  ) {
    return false;
  }
  const stateDir = realpathSync.native(resolveStateDir(env));
  try {
    return schemas.pendingMigrations.every((migration) => {
      const tables = resolveSchemaMigrationBackupTables(migration);
      const metadata = new Set(["schema_meta"]);
      if (
        migration.kind === "state" &&
        Array.from(
          { length: migration.supportedVersion - migration.foundVersion },
          (_, offset) => SCHEMA_MIGRATION_BACKUP_TABLES.state[migration.foundVersion + offset + 1],
        ).every((scope) => scope && !scope.includes("config_machine_state"))
      ) {
        metadata.add("config_machine_state");
      }
      return (
        tables !== undefined &&
        isPathInside(stateDir, realpathSync.native(migration.path)) &&
        inspectScopedMigrationTables(migration.path, tables).tables.every(
          (table) => metadata.has(table.name) || table.sql === null,
        )
      );
    });
  } catch (error) {
    if (error instanceof ScopedMigrationSnapshotUnsupportedError) {
      return false;
    }
    throw error;
  }
}

/** Backups precede both callers; agent lease acquisition must not do shared repair. */
async function prepareSharedStateForAgentMaintenance(
  params: Parameters<typeof prepareDoctorDatabaseMigrations>[0],
  changes: string[],
) {
  if (isStatePostgres()) {
    return;
  }
  const prepared = await prepareOpenClawStateDatabaseSchema(
    { env: params.env, integrityCheck: params.check ?? "quick" },
    "doctor-preparation",
  );
  if (prepared.warnings.length > 0) {
    throw new Error(prepared.warnings.join("\n"), { cause: prepared.failure });
  }
  changes.push(...prepared.changes);
  await openOpenClawStateDatabaseForDoctor({ env: params.env });
}

async function prepareUpdateAgentAdditiveSchemas(
  params: Parameters<typeof prepareDoctorDatabaseMigrations>[0],
  changes: string[],
) {
  const targets = params.agentDatabaseTargets;
  if (!hasUpdateDoctorMigrationCapture() || agentEngineInput() || !targets?.length) {
    return;
  }
  await prepareSharedStateForAgentMaintenance(params, changes);
  await withAgentDatabaseMaintenanceLease(
    { env: params.env, processBound: true },
    async (lease) => {
      for (const target of targets) {
        lease.assertOwned();
        const database = openNodeSqliteDatabase(target.path);
        try {
          await runUpdateSqliteMigrationAsync(database, target.path, () => {
            lease.assertOwned();
            return ensureOpenClawAgentSchema(database, target.agentId, target.path);
          });
        } finally {
          database.close();
        }
      }
    },
  );
}

/** Commit the declared version phase before ordinary Doctor maintenance begins. */
export async function prepareDoctorDatabaseMigrations(
  params: Omit<Parameters<typeof backupDoctorMigrationDatabases>[0], "versionMigrationsOnly">,
) {
  const result = await backupDoctorMigrationDatabases({ ...params, versionMigrationsOnly: true });
  const migrations = result.versionMigrations;
  if (!migrations?.length) {
    await prepareUpdateAgentAdditiveSchemas(params, result.changes);
    return result;
  }
  const capture = result.postgresGenerations
    ? createUpdateDoctorDatabaseWriteCapture(result.postgresGenerations, {
        env: params.env,
        signal: resolveSqliteInspectionSignal() ?? new AbortController().signal,
        assertCurrent() {
          const maintenance = getOpenClawDatabaseMaintenanceScope();
          if (!maintenance?.ownsSchemaMaintenance) {
            throw new Error("PostgreSQL version migration lost schema maintenance custody.");
          }
          maintenance.assertAdmission();
        },
        warn: (message) => result.warnings.push(message),
      })
    : undefined;
  const runMigration = <T>(operation: () => T): T =>
    capture ? capture.run(operation) : operation();
  // Acquiring an agent lease opens shared state and writes lease/registry rows.
  // Finish state-only scoped migrations before that broader maintenance begins.
  for (const migration of migrations.filter((entry) => entry.kind === "state")) {
    if (isStatePostgres()) {
      await runMigration(() =>
        openOpenClawStateDatabaseForDoctor({
          path: migration.path,
          env: params.env,
          clientCredentialMigrationFromVersion: migration.foundVersion,
        }),
      );
      result.changes.push(
        `Upgraded PostgreSQL state schema: v${migration.foundVersion} -> v${migration.supportedVersion}.`,
      );
      continue;
    }
    const migrated = await repairDoctorStateSchemaAsync(
      {
        path: migration.path,
        env: params.env,
        integrityCheck: params.check ?? "quick",
      },
      "version",
    );
    if (migrated.warnings.length > 0) {
      throw new Error(migrated.warnings.join("\n"), { cause: migrated.failure });
    }
    result.changes.push(...migrated.changes);
  }
  const agentMigrations = migrations.filter((entry) => entry.kind === "agent");
  if (agentMigrations.length > 0) {
    // Version publication can leave earlier additive repairs pending.
    await prepareSharedStateForAgentMaintenance(params, result.changes);
    await withAgentDatabaseMaintenanceLease(
      {
        env: params.env,
        processBound: true,
        schemaPolicy: isStatePostgres() ? "existing" : undefined,
      },
      async (lease) => {
        for (const migration of agentMigrations) {
          const target = params.agentDatabaseTargets?.find(({ path }) => path === migration.path);
          if (!target) {
            throw new Error(`Missing discovered agent migration target: ${migration.path}`);
          }
          const database = openNodeSqliteDatabase(target.path);
          try {
            if (agentEngineInput()) {
              lease.assertOwned();
              runMigration(() =>
                withEngineStoreAdmission(() => {
                  const engine = openAgentEngineStore(database, target.agentId, target.path, true);
                  if (engine !== database) {
                    engine.close();
                  }
                }),
              );
            } else {
              // Version-only preparation has no asynchronous integrity steps.
              await runUpdateSqliteMigrationAsync(database, target.path, () => {
                lease.assertOwned();
                return runSqliteIntegrityOperationSync(
                  ensureOpenClawAgentDatabaseSchemaSteps(database, {
                    agentId: target.agentId,
                    path: target.path,
                    env: params.env,
                    versionMigrationOnly: true,
                    integrityCheck: params.check ?? "quick",
                    onMigrationWarning: (warning) => result.warnings.push(warning),
                  }),
                );
              });
            }
          } finally {
            database.close();
          }
          result.changes.push(
            `Upgraded agent database schema in ${target.path}: v${migration.foundVersion} -> v${migration.supportedVersion}.`,
          );
        }
      },
    );
  }
  // Recovery of these images ends here. Later repairs retain their own owner
  // transactions and preserving backups, just as on a same-version Doctor run.
  try {
    completeDoctorMigrationBackups(params.env, params.databasePaths, true);
  } catch (error) {
    result.warnings.push(
      `Could not mark committed schema migration backups complete: ${formatErrorMessage(error)}`,
    );
  }
  // Scoped version backups settle before ordinary schema repair changes siblings.
  // Finish these writes before session readers enter; admission needs no exclusion.
  await prepareUpdateAgentAdditiveSchemas(params, result.changes);
  return result;
}
