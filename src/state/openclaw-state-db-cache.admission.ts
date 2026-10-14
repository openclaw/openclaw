import { getPostgresPhysicalFacts } from "../infra/database-engine/physical-facts.js";
import { isPostgresSqlConnection } from "../infra/sql-connection.js";
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
      const db = database.db;
      if (isPostgresSqlConnection(db)) {
        assertSupportedStateSchemaVersion(db, database.path);
        return getPostgresPhysicalFacts(db);
      }
      admitSqliteSchema(db);
      return runSqliteReadOperationSync(db, () => {
        assertSupportedStateSchemaVersion(db, database.path);
        return getAdmittedSqliteSchemaFacts(db);
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
      const db = database.db;
      if (isPostgresSqlConnection(db)) {
        assertSupportedStateSchemaVersion(db, database.path);
        database.schemaFacts = getPostgresPhysicalFacts(db);
        return operation(database);
      }
      let admitted = false;
      try {
        return runSqliteReadOperationSync(db, () => {
          const facts = getAdmittedSqliteSchemaFacts(db);
          if (!facts || facts !== database.schemaFacts) {
            assertSupportedStateSchemaVersion(db, database.path);
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
