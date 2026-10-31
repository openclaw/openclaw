import type { DatabaseSync } from "node:sqlite";
import { isMainThread } from "node:worker_threads";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { executeWithCachedStatement } from "./kysely-sync-cache-state.js";
import { sqliteErrorCode, sqliteExtendedResultCode } from "./sqlite-error-diagnostics.js";

const snapshots = resolveGlobalSingleton(
  Symbol.for("openclaw.sqlitePinnedReadSnapshots"),
  () => new WeakMap<DatabaseSync, object>(),
);

export function getSqlitePinnedReadSnapshot(db: DatabaseSync): object | undefined {
  return snapshots.get(db);
}

export type SqliteSchemaMarkers = { readonly schemaVersion: number; readonly userVersion: number };

/** First schema admission consumes the same cookie that pins its catalog capture. */
export function runSqliteSchemaReadSnapshotSync<T>(
  db: DatabaseSync,
  operation: (schemaVersion: number) => T,
): T {
  const parent = snapshots.get(db);
  for (let attempt = 0; ; attempt += 1) {
    // A failed first step never pinned a snapshot. Qualify fresh facts on retry,
    // while a genuinely nested acquisition retains its parent's native snapshot.
    snapshots.set(db, parent ?? {});
    try {
      const result = executeWithCachedStatement<{ retry: true } | { retry: false; value: T }>(
        db,
        "PRAGMA schema_version",
        [],
        (statement) => {
          let snapshot: ReturnType<typeof statement.iterate> | undefined;
          try {
            let first;
            try {
              // sqlite-allow-raw: Stepping this pragma pins the implicit read transaction.
              snapshot = statement.iterate();
              first = snapshot.next();
            } catch (error) {
              // Large unclean WAL recovery can outlast one native busy wait. Only
              // retry this initial read on workers, never callback work or cleanup.
              if (
                !isMainThread &&
                attempt < 4 &&
                (sqliteExtendedResultCode(error) === 261 ||
                  sqliteErrorCode(error) === "SQLITE_BUSY_RECOVERY")
              ) {
                return { retry: true };
              }
              throw error;
            }
            if (first.done) {
              throw new Error("SQLite schema_version query returned no row");
            }
            return { retry: false, value: operation(Number(first.value.schema_version)) };
          } finally {
            snapshot?.return?.();
          }
        },
      );
      if (!result.retry) {
        return result.value;
      }
    } finally {
      if (!parent) {
        snapshots.delete(db);
      }
    }
  }
}
