import { withEngineStoreAdmission } from "../infra/database-engine/admission-scope.js";
import { formatErrorMessage } from "../infra/errors.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { runSqliteIntegrityOperationSync } from "../infra/sqlite-integrity.js";
import { resolveSqliteInspectionSignal } from "../infra/sqlite-readonly-worker.js";
import {
  hasUpdateDoctorMigrationCapture,
  runUpdateSqliteMigration,
} from "../infra/update-doctor-migration-attribution.js";
import { createUpdateDoctorDatabaseWriteCapture } from "../infra/update-doctor-result.js";
import { agentEngineInput, openAgentEngineStore } from "../state/openclaw-agent-db-engine.js";
import { withAgentDatabaseMaintenanceLease } from "../state/openclaw-agent-db-maintenance-lease.js";
import {
  ensureOpenClawAgentDatabaseSchemaSteps,
  ensureOpenClawAgentSchema,
} from "../state/openclaw-agent-db-schema.js";
import { isStatePostgres } from "../state/openclaw-state-db-engine.js";
import {
  openOpenClawStateDatabase,
  repairOpenClawStateDatabaseSchema,
} from "../state/openclaw-state-db.js";
import { getOpenClawDatabaseMaintenanceScope } from "../state/openclaw-state-maintenance-context.js";
import { completeDoctorMigrationBackups } from "./doctor-migration-backup-artifacts.js";
import { backupDoctorMigrationDatabases } from "./doctor-migration-backup.js";

async function prepareUpdateAgentAdditiveSchemas(
  params: Parameters<typeof prepareDoctorDatabaseMigrations>[0],
) {
  const targets = params.agentDatabaseTargets;
  if (!hasUpdateDoctorMigrationCapture() || agentEngineInput() || !targets?.length) {
    return;
  }
  await withAgentDatabaseMaintenanceLease(
    { env: params.env, processBound: true },
    async (lease) => {
      for (const target of targets) {
        lease.assertOwned();
        const database = openNodeSqliteDatabase(target.path);
        try {
          runUpdateSqliteMigration(database, target.path, () =>
            ensureOpenClawAgentSchema(database, target.agentId, target.path),
          );
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
    await prepareUpdateAgentAdditiveSchemas(params);
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
      runMigration(() =>
        withEngineStoreAdmission(() =>
          openOpenClawStateDatabase({ path: migration.path, env: params.env }),
        ),
      );
      result.changes.push(
        `Upgraded PostgreSQL state schema: v${migration.foundVersion} -> v${migration.supportedVersion}.`,
      );
      continue;
    }
    const migrated = repairOpenClawStateDatabaseSchema({
      path: migration.path,
      env: params.env,
      versionMigrationOnly: true,
      integrityCheck: params.check ?? "quick",
    });
    if (migrated.warnings.length > 0) {
      throw new Error(migrated.warnings.join("\n"));
    }
    result.changes.push(...migrated.changes);
  }
  const agentMigrations = migrations.filter((entry) => entry.kind === "agent");
  if (agentMigrations.length > 0) {
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
              runUpdateSqliteMigration(database, target.path, () =>
                runSqliteIntegrityOperationSync(
                  ensureOpenClawAgentDatabaseSchemaSteps(database, {
                    agentId: target.agentId,
                    path: target.path,
                    env: params.env,
                    versionMigrationOnly: true,
                    integrityCheck: params.check ?? "quick",
                    onMigrationWarning: (warning) => result.warnings.push(warning),
                  }),
                ),
              );
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
  await prepareUpdateAgentAdditiveSchemas(params);
  return result;
}
