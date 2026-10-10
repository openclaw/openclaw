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

export type SqliteSchemaMarkers = { readonly schemaVersion: number; readonly userVersion: number };

/** Pin an implicit read snapshot without requiring transaction-control authorization. */
export function runSqlitePinnedReadSnapshotSync<T>(db: DatabaseSync, operation: () => T): T {
  return runPinnedSnapshot(db, "data_version", operation);
}

/** First schema admission consumes the same cookie that pins its catalog capture. */
export function runSqliteSchemaReadSnapshotSync<T>(
  db: DatabaseSync,
  operation: (schemaVersion: number) => T,
): T {
  return runPinnedSnapshot(db, "schema_version", operation);
}

function runPinnedSnapshot<T>(
  db: DatabaseSync,
  pragma: "data_version" | "schema_version",
  operation: (version: number) => T,
): T {
  const parent = snapshots.get(db);
  snapshots.set(db, parent ?? {});
  try {
    return executeWithCachedStatement(db, `PRAGMA ${pragma}`, [], (statement) => {
      // sqlite-allow-raw: Stepping this pragma pins the connection's implicit read transaction.
      const snapshot = statement.iterate();
      try {
        const first = snapshot.next();
        if (first.done) {
          throw new Error(`SQLite ${pragma} query returned no row`);
        }
        return operation(Number(first.value[pragma]));
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
