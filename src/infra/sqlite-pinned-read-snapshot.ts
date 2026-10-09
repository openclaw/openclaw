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

export function readSqliteVersionObservation(database: DatabaseSync, previousDataVersion: number) {
  const parameters = [previousDataVersion, previousDataVersion];
  // One statement pins both markers; unchanged reads never evaluate their CASE branches.
  // Function syntax refuses a table that shadows a pragma's name.
  const row = executeWithCachedStatement(
    database,
    `SELECT data_version,
      CASE WHEN data_version <> ? THEN
        (SELECT schema_version FROM main.pragma_schema_version()) END AS schema_version,
      CASE WHEN data_version <> ? THEN
        (SELECT user_version FROM main.pragma_user_version()) END AS user_version
      FROM main.pragma_data_version()`,
    parameters,
    (statement) => statement.get(...parameters),
  );
  if (typeof row?.data_version !== "number") {
    throw new Error("SQLite did not return a numeric PRAGMA data_version");
  }
  return {
    dataVersion: row.data_version,
    schemaVersion: row.schema_version,
    userVersion: row.user_version,
  };
}

export type SqliteSchemaMarkers = { readonly schemaVersion: number; readonly userVersion: number };

export function readChangedSqliteSchemaMarkers(
  database: DatabaseSync,
  facts: SqliteSchemaMarkers,
  observation?: ReturnType<typeof readSqliteVersionObservation>,
): SqliteSchemaMarkers | undefined {
  if (observation) {
    const matches =
      facts.schemaVersion === observation.schemaVersion &&
      facts.userVersion === observation.userVersion;
    return matches
      ? undefined
      : {
          schemaVersion: Number(observation.schemaVersion),
          userVersion: Number(observation.userVersion),
        };
  }
  return runSqlitePinnedReadSnapshotSync(database, (schemaVersion) => {
    const userVersion = executeWithCachedStatement(database, "PRAGMA user_version", [], (s) =>
      s.get(),
    );
    const matches =
      facts.schemaVersion === schemaVersion && facts.userVersion === userVersion?.user_version;
    return matches ? undefined : { schemaVersion, userVersion: Number(userVersion?.user_version) };
  });
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
