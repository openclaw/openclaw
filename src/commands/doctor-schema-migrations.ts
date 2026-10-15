import { formatErrorMessage } from "../infra/errors.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { runSqliteIntegrityOperationInWorker } from "../infra/sqlite-integrity-operation.js";
import { withAgentDatabaseMaintenanceLease } from "../state/openclaw-agent-db-maintenance-lease.js";
import { ensureOpenClawAgentDatabaseSchemaSteps } from "../state/openclaw-agent-db-schema.js";
import { OPENCLAW_SQLITE_BUSY_TIMEOUT_MS } from "../state/openclaw-state-db-contract.js";
import { completeDoctorMigrationBackups } from "./doctor-migration-backup-artifacts.js";
import { backupDoctorMigrationDatabases } from "./doctor-migration-backup.js";

/** Commit the declared version phase before ordinary Doctor maintenance begins. */
export async function prepareDoctorDatabaseMigrations(
  params: Omit<Parameters<typeof backupDoctorMigrationDatabases>[0], "versionMigrationsOnly">,
) {
  const result = await backupDoctorMigrationDatabases({ ...params, versionMigrationsOnly: true });
  const migrations = result.versionMigrations;
  if (!migrations?.length) {
    return result;
  }
  await withAgentDatabaseMaintenanceLease(
    { env: params.env, processBound: true },
    async (lease) => {
      for (const migration of migrations) {
        const target = params.agentDatabaseTargets?.find(({ path }) => path === migration.path);
        if (!target) {
          throw new Error(`Missing discovered agent migration target: ${migration.path}`);
        }
        using database = openNodeSqliteDatabase(target.path);
        await runSqliteIntegrityOperationInWorker(
          ensureOpenClawAgentDatabaseSchemaSteps(database, {
            agentId: target.agentId,
            path: target.path,
            env: params.env,
            versionMigrationOnly: true,
            onMigrationWarning: (warning) => result.warnings.push(warning),
          }),
          {
            busyTimeoutMs: OPENCLAW_SQLITE_BUSY_TIMEOUT_MS,
            signal: lease.signal,
            beforeResume: () => lease.assertOwned(),
          },
        );
        result.changes.push(
          `Upgraded agent database schema in ${target.path}: v${migration.foundVersion} -> v${migration.supportedVersion}.`,
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
    },
  );
  return result;
}
