import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { isSqliteCorruptionError } from "../infra/sqlite-error-diagnostics.js";
import type { createSqliteTerminalOpenLatch } from "../infra/sqlite-terminal-open-latch.js";
import { isSqliteSchemaVersionError } from "../infra/sqlite-user-version.js";
import type { OpenClawStateDatabase } from "./openclaw-state-db-contract.js";
import { assertSupportedStateSchemaVersion } from "./openclaw-state-db-schema-version.js";

type FailureOwner = {
  cachedDatabases: Map<string, OpenClawStateDatabase>;
  statements: WeakMap<OpenClawStateDatabase, ReturnType<DatabaseSync["prepare"]>>;
  dataVersions: WeakMap<DatabaseSync, number>;
  latch: ReturnType<typeof createSqliteTerminalOpenLatch>;
  evict(database: OpenClawStateDatabase): boolean;
  recordSchemaFailure(pathname: string, error: Error): void;
};

/** Runtime validation uses the cache's existing handles, version counters, and terminal latch. */
export function createOpenClawStateDatabaseRuntimeFailureOwner(owner: FailureOwner) {
  const readDataVersion = (database: OpenClawStateDatabase): number => {
    let statement = owner.statements.get(database);
    if (!statement) {
      statement =
        database.db /* sqlite-allow-raw -- Connection-local schema compatibility counter. */
          .prepare("PRAGMA data_version");
      owner.statements.set(database, statement);
    }
    const row = statement.get();
    if (typeof row?.data_version !== "number") {
      throw new Error("SQLite did not return a numeric PRAGMA data_version");
    }
    return row.data_version;
  };

  return {
    recordPublishedVersion: (database: OpenClawStateDatabase): void => {
      owner.dataVersions.set(database.db, readDataVersion(database));
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
        const dataVersion = readDataVersion(cached);
        if (owner.dataVersions.get(cached.db) === dataVersion) {
          return undefined;
        }
        // A native connection's counter detects commits by other connections.
        assertSupportedStateSchemaVersion(cached.db, resolvedPath);
        owner.dataVersions.set(cached.db, dataVersion);
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
