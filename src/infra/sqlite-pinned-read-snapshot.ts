import type { DatabaseSync } from "node:sqlite";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { executeWithCachedStatement } from "./kysely-sync-cache-state.js";

const snapshots = resolveGlobalSingleton(
  Symbol.for("openclaw.sqlitePinnedReadSnapshots"),
  () => new WeakMap<DatabaseSync, object>(),
);

export function getSqlitePinnedReadSnapshot(db: DatabaseSync): object | undefined {
  return snapshots.get(db);
}

/** Pin an implicit read snapshot without requiring transaction-control authorization. */
export function runSqlitePinnedReadSnapshotSync<T>(
  db: DatabaseSync,
  operation: (schemaVersion: number) => T,
): T {
  const parent = snapshots.get(db);
  snapshots.set(db, parent ?? {});
  try {
    return executeWithCachedStatement(db, "PRAGMA schema_version", [], (statement) => {
      // sqlite-allow-raw: Stepping this pragma pins the connection's implicit read transaction.
      const snapshot = statement.iterate();
      try {
        const first = snapshot.next();
        if (first.done) {
          throw new Error("SQLite schema version query returned no row");
        }
        return operation(Number(first.value.schema_version));
      } finally {
        snapshot.return?.();
      }
    });
  } finally {
    if (!parent) {
      snapshots.delete(db);
    }
  }
}
