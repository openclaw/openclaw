import type { DatabaseSync } from "node:sqlite";

/** The caller owns writer admission; sampling is bounded per index, not by elapsed time. */
export function refreshSqlitePlannerStatistics(database: DatabaseSync): void {
  // Include tables this maintenance connection has not queried; SQLite only
  // analyzes missing or stale statistics instead of refreshing the whole store.
  database.exec("PRAGMA analysis_limit=1000; PRAGMA optimize=0x10002;"); // sqlite-allow-raw -- SQLite-owned planner statistics.
}
