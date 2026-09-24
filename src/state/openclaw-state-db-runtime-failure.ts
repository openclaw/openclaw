import path from "node:path";
import { throwSqliteLifecycleErrors } from "../infra/sqlite-coordinator.js";
import { isSqliteCorruptionError } from "../infra/sqlite-error-diagnostics.js";
import type { createSqliteTerminalOpenLatch } from "../infra/sqlite-terminal-open-latch.js";
import { isSqliteSchemaVersionError } from "../infra/sqlite-user-version.js";
import type { OpenClawStateDatabase } from "./openclaw-state-db-contract.js";
import { markOpenClawStateDatabaseFailure } from "./openclaw-state-db-failure.js";
import { assertSupportedStateSchemaVersion } from "./openclaw-state-db-schema-version.js";

type FailureOwner = {
  cachedDatabases: Map<string, OpenClawStateDatabase>;
  latch: ReturnType<typeof createSqliteTerminalOpenLatch>;
  evict(database: OpenClawStateDatabase): boolean;
  recordSchemaFailure(pathname: string, error: Error): void;
  invalidate(pathname: string): void;
  notifyTerminalFailure(pathname: string, error: Error): void;
};

/** Runtime validation uses the cache's existing handles, version counters, and terminal latch. */
export function createOpenClawStateDatabaseRuntimeFailureOwner(owner: FailureOwner) {
  return {
    closeTerminalFailure(pathname: string, error: Error): void {
      markOpenClawStateDatabaseFailure(error, pathname);
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
    get: (pathname: string): Error | undefined => {
      const resolvedPath = path.resolve(pathname);
      const latched = owner.latch.get(resolvedPath);
      if (latched) {
        return latched;
      }
      const cached = owner.cachedDatabases.get(resolvedPath);
      if (!cached?.db.isOpen) {
        return undefined;
      }
      try {
        // Admission retains schema facts but checks foreign commits before reusing them.
        assertSupportedStateSchemaVersion(cached.db, resolvedPath);
        return undefined;
      } catch (error) {
        const failure = error instanceof Error ? error : new Error(String(error));
        if (isSqliteCorruptionError(failure)) {
          owner.evict(cached);
          return undefined;
        }
        if (isSqliteSchemaVersionError(failure)) {
          owner.recordSchemaFailure(resolvedPath, failure);
        }
        return failure;
      }
    },
  };
}
