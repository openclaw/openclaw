import type { DatabaseSync } from "node:sqlite";
import { executeSqliteQueryTakeFirstSync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";

export function readTotalChanges(db: DatabaseSync): number {
  const row = executeSqliteQueryTakeFirstSync(
    db,
    getNodeSqliteKysely(db).selectNoFrom((eb) => eb.fn<number>("total_changes", []).as("value")),
  );
  if (typeof row?.value !== "number") {
    throw new Error("SQLite did not return a numeric total_changes() value");
  }
  return row.value;
}
