import fs from "node:fs";
import { performance } from "node:perf_hooks";
import { backupDoctorPostgresMigration } from "../commands/doctor-postgres-migration.js";
import { backfillSessionColdNavigationInTransaction } from "../config/sessions/session-cold-storage-navigation.js";
import { readSessionColdTranscript } from "../config/sessions/session-cold-storage-state.js";
import { agentEngineInput, openAgentEngineStore } from "../state/openclaw-agent-db-engine.js";
import { assertAgentDatabaseMaintenanceAuthority } from "../state/openclaw-agent-db-maintenance-authority.js";
import { withAgentDatabaseMaintenanceLease } from "../state/openclaw-agent-db-maintenance-lease.js";
import { assertOpenClawAgentDatabaseForMaintenance } from "../state/openclaw-agent-db-maintenance.js";
import type { DB } from "../state/openclaw-agent-db.generated.js";
import { withEngineStoreAdmission } from "./database-engine/admission-scope.js";
import { formatErrorMessage } from "./errors.js";
import {
  clearNodeSqliteKyselyCacheForDatabase,
  enableNodeSqliteKyselyStatementCache,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "./kysely-sync.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import {
  sqliteSessionIdWriteScope,
  withSqliteDatabaseWriteScope,
} from "./sqlite-database-admission.js";
import { backupDoctorSqliteRepair } from "./sqlite-index-recovery.js";
import { resolveSqliteInspectionSignal } from "./sqlite-readonly-worker.js";
import { admitSqliteSchema } from "./sqlite-schema-facts.js";
import { runSqliteImmediateTransactionSync } from "./sqlite-transaction.js";
import {
  resolveAgentDatabaseMigrationTargets,
  type PreparedAgentDatabaseMigrationDiscovery,
  type AgentDatabaseMigrationTarget,
} from "./state-migrations.media-persistence-targets.js";
import type { MigrationMessages } from "./state-migrations.types.js";

const COLD_NAVIGATION_WORK_BUDGET_MS = 10 * 60_000;

/** Doctor adds reconstructible navigation one archive at a time; failures retain the source for retry. */
export async function migrateSessionColdNavigation(
  params: {
    configuredAgentDatabaseTargets?: readonly { agentId: string; path: string }[];
    preparedDiscovery?: PreparedAgentDatabaseMigrationDiscovery;
    preparedTargets?: readonly AgentDatabaseMigrationTarget[];
    env?: NodeJS.ProcessEnv;
  } = {},
): Promise<MigrationMessages> {
  const env = params.env ?? process.env;
  const signal = resolveSqliteInspectionSignal();
  const changes: string[] = [];
  const warnings: string[] = [];
  let remainingWorkMs = COLD_NAVIGATION_WORK_BUDGET_MS;
  signal?.throwIfAborted();
  // Empty admitted discovery has no work; acquiring a lease would dirty shared state.
  if (params.preparedTargets?.length === 0) {
    return { changes, warnings };
  }
  try {
    await withAgentDatabaseMaintenanceLease({ env, processBound: true }, async (maintenance) => {
      const assertCurrent = () => {
        signal?.throwIfAborted();
        maintenance.signal.throwIfAborted();
        assertAgentDatabaseMaintenanceAuthority(maintenance);
      };
      assertCurrent();
      const targets =
        params.preparedTargets ??
        resolveAgentDatabaseMigrationTargets({
          ...params,
          env,
          changes,
          warnings,
          configuredAgentDatabaseTargets: params.configuredAgentDatabaseTargets ?? [],
        }).targets;
      for (const target of targets) {
        try {
          assertCurrent();
          if (fs.realpathSync.native(target.path) !== target.realPath) {
            throw new Error(
              `Agent database path changed since migration discovery: ${target.path}`,
            );
          }
          using anchor = openNodeSqliteDatabase(target.path);
          enableNodeSqliteKyselyStatementCache(anchor);
          const native = withEngineStoreAdmission(() => {
            if (agentEngineInput()) {
              return openAgentEngineStore(anchor, target.agentId, target.path, true);
            }
            assertOpenClawAgentDatabaseForMaintenance(anchor, {
              agentId: target.agentId,
              pathname: target.path,
            });
            admitSqliteSchema(anchor);
            return anchor;
          });
          const database = { db: native, path: target.path };
          try {
            const db = getNodeSqliteKysely<DB>(database.db);
            const pending = db
              .selectFrom("session_transcript_cold_archives as archive")
              .select("archive.session_id")
              .where((eb) =>
                eb.not(
                  eb.exists(
                    eb
                      .selectFrom("transcript_events as event")
                      .select("event.seq")
                      .whereRef("event.session_id", "=", "archive.session_id"),
                  ),
                ),
              )
              .orderBy("archive.session_id")
              .limit(1);
            let cursor: string | undefined;
            let backedUp = false;
            let migrated = 0;
            while (true) {
              assertCurrent();
              const next = withEngineStoreAdmission(() =>
                executeSqliteQueryTakeFirstSync(
                  database.db,
                  cursor === undefined ? pending : pending.where("archive.session_id", ">", cursor),
                ),
              );
              if (!next) {
                break;
              }
              if (remainingWorkMs <= 0) {
                const count = withEngineStoreAdmission(() =>
                  executeSqliteQueryTakeFirstSync(
                    database.db,
                    pending
                      .clearSelect()
                      .clearOrderBy()
                      .clearLimit()
                      .select((eb) => eb.fn.countAll<number>().as("count")),
                  ),
                );
                warnings.push(
                  `Cold transcript navigation in ${target.path}: migrated ${migrated}, pending ${count?.count ?? 0}; resumes on the next doctor run (openclaw doctor --fix). Pending archives keep the existing cold-restore path.`,
                );
                break;
              }
              cursor = next.session_id;
              if (!backedUp) {
                const postgres = agentEngineInput();
                if (postgres) {
                  const backup = await backupDoctorPostgresMigration(target.path, postgres, {
                    assertAdmission: assertCurrent,
                  });
                  changes.push(...backup.changes);
                } else {
                  changes.push(
                    `Saved pre-repair SQLite backup: ${backupDoctorSqliteRepair(target.path, "cold-navigation")}`,
                  );
                }
                backedUp = true;
              }
              // Share one archive-work budget across databases, excluding their backups.
              const startedAt = performance.now();
              try {
                const completed = withEngineStoreAdmission(() =>
                  runSqliteImmediateTransactionSync(
                    database.db,
                    () => {
                      assertCurrent();
                      const archive = readSessionColdTranscript(database.db, next.session_id);
                      if (
                        !archive ||
                        executeSqliteQueryTakeFirstSync(
                          database.db,
                          db
                            .selectFrom("transcript_events")
                            .select("seq")
                            .where("session_id", "=", next.session_id)
                            .limit(1),
                        )
                      ) {
                        return false;
                      }
                      withSqliteDatabaseWriteScope(
                        database.db,
                        [sqliteSessionIdWriteScope(next.session_id)],
                        () => {
                          backfillSessionColdNavigationInTransaction(database, archive);
                        },
                      );
                      return true;
                    },
                    {
                      databaseLabel: target.path,
                      operationLabel: "session.cold-navigation-migration",
                      withCommit: (commit) => {
                        assertCurrent();
                        commit();
                      },
                    },
                  ),
                );
                migrated += Number(completed);
              } catch (error) {
                assertCurrent();
                warnings.push(
                  `Cold transcript navigation remains pending in ${target.path}; run openclaw doctor --fix to retry: ${formatErrorMessage(error)}`,
                );
              }
              // No transaction or decoded archive remains live across this yield.
              await new Promise<void>((resolve) => {
                setImmediate(resolve);
              });
              remainingWorkMs -= performance.now() - startedAt;
            }
            if (migrated) {
              changes.push(
                `Retained navigation for ${migrated} cold transcript(s) in ${target.path}; archive payloads remain unchanged.`,
              );
            }
          } finally {
            clearNodeSqliteKyselyCacheForDatabase(anchor);
            if (native !== anchor) {
              withEngineStoreAdmission(() => native.close());
            }
          }
        } catch (error) {
          assertCurrent();
          warnings.push(
            `Skipped cold transcript navigation migration for ${target.path}; run openclaw doctor --fix to retry: ${formatErrorMessage(error)}`,
          );
        }
      }
    });
  } catch (error) {
    signal?.throwIfAborted();
    warnings.push(
      `Skipped cold transcript navigation migration; run openclaw doctor --fix to retry: ${formatErrorMessage(error)}`,
    );
  }
  return {
    changes,
    warnings,
    ...(warnings.length ? { warningDisposition: "recoverable" as const } : {}),
  };
}
