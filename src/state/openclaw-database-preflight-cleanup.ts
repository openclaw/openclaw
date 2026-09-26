import type { DatabaseSync } from "node:sqlite";
import { clearNodeSqliteKyselyCacheForDatabase } from "../infra/kysely-sync.js";
import { throwSqliteLifecycleErrors } from "../infra/sqlite-lifecycle-errors.js";
import { SqliteSnapshotCleanupError } from "../infra/sqlite-readonly-location-cleanup.js";
import type { PreparedSqliteReadOnlyLocation } from "../infra/sqlite-readonly-location.types.js";

/** Failed retirement keeps its existing snapshot owner and cannot admit more schemas. */
export async function cleanupOpenClawStatePreflight(options: {
  database: DatabaseSync | undefined;
  closeAdmission: (() => void) | undefined;
  snapshot: PreparedSqliteReadOnlyLocation | undefined;
  inspectionErrors: readonly unknown[];
}): Promise<void> {
  const cleanupErrors: unknown[] = [];
  if (options.database) {
    try {
      options.closeAdmission?.();
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      clearNodeSqliteKyselyCacheForDatabase(options.database);
      options.database.close();
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  try {
    if (options.snapshot && !(await options.snapshot.cleanupAsync())) {
      cleanupErrors.push(
        new SqliteSnapshotCleanupError(
          `SQLite read-only worker snapshot cleanup failed: ${options.snapshot.location}`,
        ),
      );
    }
  } catch (error) {
    cleanupErrors.push(error);
  }
  if (cleanupErrors.length > 0) {
    // Preserve an earlier inspection/cancellation as the cause and first error.
    throwSqliteLifecycleErrors(
      [...options.inspectionErrors, ...cleanupErrors],
      "State database schema inspection cleanup failed",
    );
  }
}
