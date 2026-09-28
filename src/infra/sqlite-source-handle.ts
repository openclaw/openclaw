// Native source readers run in an isolated child or an already-drained owner.
import type { DatabaseSync } from "node:sqlite";
import { assertStateDatabaseAccessAllowed } from "./gateway-state-owner.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import { withSqliteInspectionOperation } from "./sqlite-error-diagnostics.js";

// A failed native close remains owned until the reader process exits.
const unclosedSourceReads = new Set<DatabaseSync>();

/** Closing a source in its writer's process can release that writer's POSIX locks. */
export function withSqliteSourceReadDatabase<T>(
  pathname: string,
  inspectionOperation: "source" | "snapshot",
  operation: (database: DatabaseSync) => T,
): T {
  assertStateDatabaseAccessAllowed(pathname);
  const database = withSqliteInspectionOperation(inspectionOperation, () =>
    openNodeSqliteDatabase(pathname, { readOnly: true }),
  );
  try {
    assertStateDatabaseAccessAllowed(pathname);
    return operation(database);
  } finally {
    try {
      database.close();
    } finally {
      if (database.isOpen) {
        unclosedSourceReads.add(database);
      }
    }
  }
}
