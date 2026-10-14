import type { DatabaseSync } from "node:sqlite";

/** The caller owns writer admission; sampling is bounded per index, not by elapsed time. */
export function refreshSqlitePlannerStatistics(database: DatabaseSync): void {
  // Explicit ANALYZE includes every table on supported SQLite versions before 3.46.
  database.exec("PRAGMA analysis_limit=1000; ANALYZE main;"); // sqlite-allow-raw -- SQLite-owned planner statistics.
}
