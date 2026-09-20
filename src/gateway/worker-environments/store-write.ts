import type { DatabaseSync } from "node:sqlite";
import { executeSqliteQueryTakeFirstSync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import { runOpenClawStateWriteTransaction } from "../../state/openclaw-state-db.js";

function readTotalChanges(db: DatabaseSync): number {
  const row = executeSqliteQueryTakeFirstSync(
    db,
    getNodeSqliteKysely(db).selectNoFrom((eb) => eb.fn<number>("total_changes", []).as("value")),
  );
  if (typeof row?.value !== "number") {
    throw new Error("SQLite did not return a numeric total_changes() value");
  }
  return row.value;
}

export function createWorkerEnvironmentStoreWriter(path: string) {
  let inventoryVersion = 0;
  return {
    write: <T>(operation: (db: DatabaseSync) => T): T => {
      const result = runOpenClawStateWriteTransaction(
        ({ db }) => {
          const changesBefore = readTotalChanges(db);
          const value = operation(db);
          if (readTotalChanges(db) !== changesBefore) {
            sessionChanges.emit({ all: true, scope: "worker-environments" }, db);
          }
          return value;
        },
        { path },
      );
      // Device pairing's nodeDeviceId patch deliberately stays outside this version:
      // it changes no identity/epoch/state input. Runner availability owns its own fence.
      inventoryVersion += 1;
      return result;
    },
    inventoryVersion: () => inventoryVersion,
  };
}
