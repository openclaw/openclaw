import type { DatabaseSync } from "node:sqlite";

/** Configure page-cache headroom for disposable migration and inspection handles. */
export function configureSqliteMaintenanceCache(database: DatabaseSync): void {
  // Full index checks and table rebuilds revisit pages; retained runtime handles
  // keep their normal budget. Negative cache_size is a connection-local KiB budget.
  database.exec("PRAGMA cache_size = -65536;"); // sqlite-allow-raw -- Disposable maintenance connection cache policy.
}
