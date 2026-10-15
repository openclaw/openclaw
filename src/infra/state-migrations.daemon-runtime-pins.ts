import { resolveStateDir } from "../config/paths.js";
import {
  type DaemonRuntimePinDatabase,
  withDaemonRuntimePinStore,
} from "../daemon/runtime-pin-store.js";
import { deleteConfigMachineState } from "../state/config-machine-state-write.js";
import { withExistingOpenClawStateDatabaseReadOnly } from "../state/openclaw-state-db-readonly.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "./kysely-sync.js";
import { withLegacyMigrationStateLock } from "./state-migrations.lock.js";
import type { MigrationMessages } from "./state-migrations.types.js";

/** Move raw intent before retiring its source; exact duplicates resume an interrupted copy. */
export async function migrateDaemonRuntimePins(env: NodeJS.ProcessEnv): Promise<MigrationMessages> {
  const hasSource = withExistingOpenClawStateDatabaseReadOnly(
    ({ db }) =>
      executeSqliteQueryTakeFirstSync(
        db,
        getNodeSqliteKysely<Pick<DB, "config_machine_state">>(db)
          .selectFrom("config_machine_state")
          .select("state_key")
          .where("state_key", "like", "daemon-runtime-pin:%")
          .limit(1),
      ),
    { env },
  );
  if (!hasSource) {
    return { changes: [], warnings: [] };
  }
  return await withLegacyMigrationStateLock({
    env,
    stateDir: resolveStateDir(env),
    label: "daemon runtime pins",
    releaseLabel: "Daemon runtime pin",
    errorLabel: "Failed migrating daemon runtime pins",
    run: async (lockedEnv) => {
      const moved = runOpenClawStateWriteTransaction(
        (database) => {
          const source = database.db;
          const sourceDb = getNodeSqliteKysely<Pick<DB, "config_machine_state">>(source);
          const rows = executeSqliteQuerySync(
            source,
            sourceDb
              .selectFrom("config_machine_state")
              .select(["state_key", "value_json", "updated_at_ms"])
              .where("state_key", "like", "daemon-runtime-pin:%"),
          ).rows;
          if (rows.length === 0) {
            return 0;
          }
          withDaemonRuntimePinStore(lockedEnv, true, (target) => {
            const targetDb = getNodeSqliteKysely<DaemonRuntimePinDatabase>(target);
            for (const row of rows) {
              const existing = executeSqliteQueryTakeFirstSync(
                target,
                targetDb
                  .selectFrom("daemon_runtime_pins")
                  .select(["state_key", "value_json", "updated_at_ms"])
                  .where("state_key", "=", row.state_key),
              );
              if (
                existing &&
                (existing.value_json !== row.value_json ||
                  existing.updated_at_ms !== row.updated_at_ms)
              ) {
                throw new Error(
                  `Daemon runtime pin migration conflict for ${row.state_key}; both stores were retained. Back up and reconcile the stores with OpenClaw stopped, then run openclaw doctor --fix.`,
                );
              }
              if (!existing) {
                executeSqliteQuerySync(
                  target,
                  targetDb.insertInto("daemon_runtime_pins").values(row),
                );
              }
            }
          });
          // The target commits first. A crash before source commit leaves exact duplicates.
          for (const row of rows) {
            deleteConfigMachineState(row.state_key, { env: lockedEnv, database });
          }
          return rows.length;
        },
        { env: lockedEnv },
        { operationLabel: "state-migration.daemon-runtime-pins" },
      );
      return {
        changes: moved > 0 ? [`Moved ${moved} daemon runtime pin(s) to local service intent.`] : [],
        warnings: [],
      };
    },
  });
}
