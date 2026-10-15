import fs from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { resolveStateDir } from "../config/paths.js";
import {
  completeUnshippedDaemonRuntimePinMigration,
  type DaemonRuntimePinDatabase,
  withDaemonRuntimePinStore,
} from "../daemon/runtime-pin-store.js";
import { deleteConfigMachineState } from "../state/config-machine-state-write.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "./kysely-sync.js";
import { withLegacyMigrationStateLock } from "./state-migrations.lock.js";
import type { MigrationMessages } from "./state-migrations.types.js";

export async function migrateDaemonRuntimePins(env: NodeJS.ProcessEnv): Promise<MigrationMessages> {
  if (completeUnshippedDaemonRuntimePinMigration(env)) {
    return { changes: [], warnings: [] };
  }
  const sourceState = resolveOpenClawStateSqlitePath(env);
  const receipt = (db: DatabaseSync, phase: "copied" | "complete") => {
    const result = db
      .prepare(`
      INSERT INTO daemon_runtime_pin_migration VALUES (1, ?, ?, ?)
      ON CONFLICT(version) DO UPDATE SET source_state=excluded.source_state,
        phase=excluded.phase, updated_at=excluded.updated_at
      WHERE daemon_runtime_pin_migration.phase != 'copied'
        OR daemon_runtime_pin_migration.source_state = excluded.source_state
    `)
      .run(sourceState, phase, Date.now());
    if (result.changes === 0) {
      throw new Error(
        "Runtime pin migration source changed; both stores were retained. Restore the original source and run openclaw doctor.",
      );
    }
  };
  return await withLegacyMigrationStateLock({
    env,
    stateDir: resolveStateDir(env),
    label: "daemon runtime pins",
    releaseLabel: "Daemon runtime pin",
    errorLabel: "Failed migrating daemon runtime pins",
    run: async (lockedEnv) => {
      const previous = withDaemonRuntimePinStore(lockedEnv, false, (db) =>
        db.prepare("SELECT source_state, phase FROM daemon_runtime_pin_migration").get(),
      );
      if (previous?.phase === "complete" && previous.source_state === sourceState) {
        return { changes: [], warnings: [] };
      }
      const moved = !fs.existsSync(sourceState)
        ? 0
        : runOpenClawStateWriteTransaction(
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
                receipt(target, "copied");
                const targetDb = getNodeSqliteKysely<DaemonRuntimePinDatabase>(target);
                const existing = executeSqliteQuerySync(
                  target,
                  targetDb.selectFrom("daemon_runtime_pins").selectAll(),
                ).rows;
                for (const saved of existing) {
                  const row = rows.find((candidate) => candidate.state_key === saved.state_key);
                  if (
                    row &&
                    (saved.value_json !== row.value_json ||
                      saved.updated_at_ms !== row.updated_at_ms)
                  ) {
                    throw new Error(
                      `Daemon runtime pin migration conflict for ${row.state_key}; both stores were retained. Back up and reconcile the stores with OpenClaw stopped, then run openclaw doctor --fix.`,
                    );
                  }
                }
                executeSqliteQuerySync(
                  target,
                  targetDb
                    .insertInto("daemon_runtime_pins")
                    .values(rows)
                    .onConflict((conflict) => conflict.column("state_key").doNothing()),
                );
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
      withDaemonRuntimePinStore(lockedEnv, true, (db) => receipt(db, "complete"));
      return {
        changes: moved > 0 ? [`Moved ${moved} daemon runtime pin(s) to local service intent.`] : [],
        warnings: [],
      };
    },
  });
}
