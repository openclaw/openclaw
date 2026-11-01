import type { DatabaseSync } from "node:sqlite";
import {
  readExistingAgentSchemaMeta,
  type ExistingAgentSchemaMeta,
} from "../state/openclaw-agent-db-metadata.js";
import { OPENCLAW_SQLITE_BUSY_TIMEOUT_MS } from "../state/openclaw-state-db-contract.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import { setSqliteBusyTimeout } from "./sqlite-busy-timeout.js";
import { runWithSqliteCleanup } from "./sqlite-lifecycle-errors.js";
import type { PreparedSqliteReadOnlyLocation } from "./sqlite-readonly-location.types.js";
import { runSqliteReadSnapshotSync } from "./sqlite-transaction.js";
import { readSqliteUserVersion, readSqliteWriterAppVersion } from "./sqlite-user-version.js";
import { configureSqliteReadOnlyPragmas } from "./sqlite-wal.js";

export type SqliteSchemaHeader = {
  userVersion: number;
  writerAppVersion?: string;
  agentSchemaMeta?: ExistingAgentSchemaMeta | null;
};

/** Read version and requested ownership facts from one fresh transaction, including WAL. */
export function readSqliteSchemaHeader(
  database: DatabaseSync,
  agentSchemaVersionForOwnership?: number,
): SqliteSchemaHeader {
  configureSqliteReadOnlyPragmas(database);
  return runSqliteReadSnapshotSync(
    database,
    () => {
      const userVersion = readSqliteUserVersion(database);
      const writerAppVersion = readSqliteWriterAppVersion(database);
      return {
        userVersion,
        ...(writerAppVersion ? { writerAppVersion } : {}),
        // A newer schema may have a different metadata contract; its version alone refuses admission.
        ...(agentSchemaVersionForOwnership !== undefined &&
        userVersion <= agentSchemaVersionForOwnership
          ? { agentSchemaMeta: readExistingAgentSchemaMeta(database) }
          : {}),
      };
    },
    { operationLabel: "database.schema-header" },
  );
}

/** Consume a private snapshot and retain both read and cleanup failures. */
export function readSqliteSchemaHeaderFromSnapshot(
  prepared: PreparedSqliteReadOnlyLocation,
  signal?: AbortSignal,
  agentSchemaVersionForOwnership?: number,
): SqliteSchemaHeader {
  return runWithSqliteCleanup(
    {
      release: () => {
        if (!prepared.cleanup()) {
          throw new Error(`SQLite read-only worker snapshot cleanup failed: ${prepared.location}`);
        }
      },
    },
    "SQLite schema header snapshot",
    () => {
      const location = prepared.location;
      signal?.throwIfAborted();
      const database = openNodeSqliteDatabase(location, { readOnly: true });
      return runWithSqliteCleanup(
        { release: () => database.close() },
        "SQLite schema header read",
        () => {
          setSqliteBusyTimeout(database, OPENCLAW_SQLITE_BUSY_TIMEOUT_MS);
          return readSqliteSchemaHeader(database, agentSchemaVersionForOwnership);
        },
      );
    },
  );
}
