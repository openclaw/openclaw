// Native source readers run in an isolated child or an already-drained owner.
import type { DatabaseSync } from "node:sqlite";
import {
  assertStateDatabaseAccessAllowed,
  withStateDatabaseColdAdmission,
} from "./gateway-state-owner.js";
import { openNodeSqliteDatabase, resolveReadOnlyShmSqliteFileUri } from "./node-sqlite.js";
import { withSqliteInspectionOperation } from "./sqlite-error-diagnostics.js";

// A failed native close remains owned until the reader process exits.
const unclosedSourceReads = new Set<DatabaseSync>();

function closeSourceRead(database: DatabaseSync): void {
  try {
    database.close();
  } finally {
    if (database.isOpen) {
      unclosedSourceReads.add(database);
    }
  }
}

/** Closing a source in its writer's process can release that writer's POSIX locks. */
export function withSqliteSourceReadDatabase<T>(
  pathname: string,
  inspectionOperation: "source" | "snapshot",
  operation: (database: DatabaseSync) => T,
  options: (
    | { timeout?: number; waitForAdmission?: false }
    | {
        timeout: number;
        waitForAdmission: true;
      }
  ) & { readOnlyShm?: boolean } = {},
): T {
  const openAdmitted = (timeout: number | undefined) => {
    const database = withSqliteInspectionOperation(inspectionOperation, () =>
      openNodeSqliteDatabase(
        options.readOnlyShm ? resolveReadOnlyShmSqliteFileUri(pathname) : pathname,
        { readOnly: true, timeout },
      ),
    );
    try {
      assertStateDatabaseAccessAllowed(pathname);
      return database;
    } catch (error) {
      closeSourceRead(database);
      throw error;
    }
  };

  if (!options.waitForAdmission) {
    assertStateDatabaseAccessAllowed(pathname);
  }
  const database = options.waitForAdmission
    ? withStateDatabaseColdAdmission(
        { databasePath: pathname, busyTimeoutMs: options.timeout },
        (remaining) => openAdmitted(remaining()),
      )
    : openAdmitted(options.timeout);
  try {
    return operation(database);
  } finally {
    closeSourceRead(database);
  }
}
