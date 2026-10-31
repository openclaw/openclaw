import { revokeSqliteDatabaseAdmissionsForPath } from "../infra/sqlite-database-admission.js";
import { isSqliteCorruptionError } from "../infra/sqlite-error-diagnostics.js";
import { throwSqliteLifecycleErrors } from "../infra/sqlite-lifecycle-errors.js";
import { runSqliteReadOperationSync } from "../infra/sqlite-schema-facts.js";
import type { OpenClawStateDatabase } from "./openclaw-state-db-contract.js";
import { markOpenClawStateDatabaseFailure } from "./openclaw-state-db-failure.js";

type CacheAdmissionOwner = {
  cachedDatabases: Map<string, OpenClawStateDatabase>;
  evict(database: OpenClawStateDatabase): boolean;
  invalidate(pathname: string): void;
  notifyTerminalFailure(pathname: string, error: Error): void;
};

/** Keep cached reads and terminal failures with their exact native owner. */
export function createStateDatabaseCacheAdmission(owner: CacheAdmissionOwner) {
  return {
    closeTerminalFailure(pathname: string, error: Error): void {
      markOpenClawStateDatabaseFailure(error, pathname);
      // A refused open must also retire schema facts republished during acquisition.
      revokeSqliteDatabaseAdmissionsForPath(pathname);
      owner.invalidate(pathname);
      const cached = owner.cachedDatabases.get(pathname);
      const errors: unknown[] = [];
      try {
        if (cached) {
          owner.evict(cached);
        }
      } catch (cleanupError) {
        errors.push(cleanupError);
      }
      try {
        owner.notifyTerminalFailure(pathname, error);
      } catch (notificationError) {
        errors.push(notificationError);
      }
      throwSqliteLifecycleErrors(errors, "Terminal shared-state failure cleanup failed");
    },
    read<T>(
      database: OpenClawStateDatabase,
      operation: (database: OpenClawStateDatabase) => T,
    ): T | undefined {
      if (!database.db.isOpen) {
        return operation(database);
      }
      let admitted = false;
      try {
        return runSqliteReadOperationSync(database.db, () => {
          admitted = true;
          return operation(database);
        });
      } catch (error) {
        // Only read-scope setup failures belong here; the consuming owner handles its read.
        if (admitted) {
          throw error;
        }
        const failure = error instanceof Error ? error : new Error(String(error));
        if (isSqliteCorruptionError(failure)) {
          owner.evict(database);
          return undefined;
        }
        throw failure;
      }
    },
  };
}
