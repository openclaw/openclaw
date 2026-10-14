import { isSqliteCorruptionError } from "../infra/sqlite-error-diagnostics.js";
import { throwSqliteLifecycleErrors } from "../infra/sqlite-lifecycle-errors.js";
import {
  admitSqliteSchema,
  getAdmittedSqliteSchemaFacts,
  runSqliteReadOperationSync,
} from "../infra/sqlite-schema-facts.js";
import { isSqliteSchemaVersionError } from "../infra/sqlite-user-version.js";
import type { CachedOpenClawStateDatabase } from "./openclaw-state-db-cache.types.js";
import type { OpenClawStateDatabase } from "./openclaw-state-db-contract.js";
import { markOpenClawStateDatabaseFailure } from "./openclaw-state-db-failure.js";
import { assertSupportedStateSchemaVersion } from "./openclaw-state-db-schema-version.js";

type CacheAdmissionOwner = {
  cachedDatabases: Map<string, CachedOpenClawStateDatabase>;
  evict(database: OpenClawStateDatabase): boolean;
  recordSchemaFailure(pathname: string, error: Error): void;
  invalidate(pathname: string): void;
  notifyTerminalFailure(pathname: string, error: Error): void;
};

/** Refresh cached-handle admission and settle failures against its exact native owner. */
export function createStateDatabaseCacheAdmission(owner: CacheAdmissionOwner) {
  return {
    initialize(database: OpenClawStateDatabase) {
      admitSqliteSchema(database.db);
      return runSqliteReadOperationSync(database.db, () => {
        assertSupportedStateSchemaVersion(database.db, database.path);
        return getAdmittedSqliteSchemaFacts(database.db);
      });
    },
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
    read<T>(pathname: string, operation: (database: OpenClawStateDatabase) => T): T | undefined {
      const database = owner.cachedDatabases.get(pathname);
      if (!database) {
        return undefined;
      }
      if (!database.db.isOpen) {
        return operation(database);
      }
      let admitted = false;
      try {
        return runSqliteReadOperationSync(database.db, () => {
          const facts = getAdmittedSqliteSchemaFacts(database.db);
          if (!facts || facts !== database.schemaFacts) {
            assertSupportedStateSchemaVersion(database.db, database.path);
            database.schemaFacts = facts;
          }
          admitted = true;
          return operation(database);
        });
      } catch (error) {
        // Only freshness failures belong to admission; the consuming owner handles its read.
        if (admitted) {
          throw error;
        }
        const failure = error instanceof Error ? error : new Error(String(error));
        if (isSqliteCorruptionError(failure)) {
          owner.evict(database);
          return undefined;
        }
        if (isSqliteSchemaVersionError(failure)) {
          owner.recordSchemaFailure(database.path, failure);
        }
        throw failure;
      }
    },
  };
}
