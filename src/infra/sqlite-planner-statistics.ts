import type { DatabaseSync } from "node:sqlite";
import { captureSqliteNativeRuntimeAdmission } from "./node-sqlite.js";
import { compareValidSemver } from "./semver.js";

/** The caller owns writer admission; sampling is bounded per index, not by elapsed time. */
export function refreshSqlitePlannerStatistics(database: DatabaseSync): void {
  const version = captureSqliteNativeRuntimeAdmission()?.version;
  if (version && (compareValidSemver(version, "3.46.0") ?? 0) < 0) {
    // The supported SQLite 3.44 line lacks optimize's all-table mask;
    // analyze explicitly with the same per-index sampling bound.
    database.exec("PRAGMA analysis_limit=1000; ANALYZE main;"); // sqlite-allow-raw -- SQLite-owned planner statistics.
    return;
  }
  // Include tables this maintenance connection has not queried; SQLite only
  // analyzes missing or stale statistics instead of refreshing the whole store.
  database.exec("PRAGMA analysis_limit=1000; PRAGMA optimize=0x10002;"); // sqlite-allow-raw -- SQLite-owned planner statistics.
}
