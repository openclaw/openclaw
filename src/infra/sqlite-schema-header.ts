import type { DatabaseSync } from "node:sqlite";
import {
  readExistingAgentSchemaMeta,
  type ExistingAgentSchemaMeta,
} from "../state/openclaw-agent-db-metadata.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../state/openclaw-agent-db.generated.js";
import { OPENCLAW_SQLITE_BUSY_TIMEOUT_MS } from "../state/openclaw-state-db-contract.js";
import { executeSqliteQueryTakeFirstSync, getNodeSqliteKysely } from "./kysely-sync.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import { setSqliteBusyTimeout } from "./sqlite-busy-timeout.js";
import {
  createSqliteLifecycleAggregateError,
  runWithSqliteCoordinator,
  SqliteCoordinatorError,
} from "./sqlite-coordinator.js";
import type { PreparedSqliteReadOnlyLocation } from "./sqlite-readonly-location.types.js";
import { runSqliteDeferredTransactionSync } from "./sqlite-transaction.js";
import { readSqliteUserVersion } from "./sqlite-user-version.js";
import { configureSqliteReadOnlyPragmas } from "./sqlite-wal.js";

export type SqliteSchemaHeader = {
  userVersion: number;
  writerAppVersion?: string;
  agentSchemaMeta?: ExistingAgentSchemaMeta | null;
};

export function readSqliteWriterAppVersion(database: DatabaseSync): string | undefined {
  try {
    // Schema metadata inspection also accepts older or newer metadata contracts.
    const row = executeSqliteQueryTakeFirstSync(
      database,
      getNodeSqliteKysely<Pick<OpenClawAgentKyselyDatabase, "schema_meta">>(database)
        .selectFrom("schema_meta")
        .select("app_version")
        .where("meta_key", "=", "primary")
        .limit(1),
    );
    return typeof row?.app_version === "string" && row.app_version.length > 0
      ? row.app_version
      : undefined;
  } catch {
    return undefined;
  }
}

/** Read version and requested ownership facts from one fresh transaction, including WAL. */
export function readSqliteSchemaHeader(
  database: DatabaseSync,
  agentSchemaVersionForOwnership?: number,
): SqliteSchemaHeader {
  configureSqliteReadOnlyPragmas(database);
  return runSqliteDeferredTransactionSync(database, () => {
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
  });
}

function readSqliteSchemaHeaderSnapshot(
  location: string,
  signal?: AbortSignal,
  agentSchemaVersionForOwnership?: number,
): SqliteSchemaHeader {
  signal?.throwIfAborted();
  const database = openNodeSqliteDatabase(location, { readOnly: true });
  return runWithSqliteCoordinator(
    { release: () => database.close() },
    "SQLite schema header read",
    () => {
      setSqliteBusyTimeout(database, OPENCLAW_SQLITE_BUSY_TIMEOUT_MS);
      return readSqliteSchemaHeader(database, agentSchemaVersionForOwnership);
    },
  );
}

/** Consume a private snapshot and retain both read and cleanup failures. */
export function readSqliteSchemaHeaderFromSnapshot(
  prepared: PreparedSqliteReadOnlyLocation,
  signal?: AbortSignal,
  agentSchemaVersionForOwnership?: number,
): SqliteSchemaHeader {
  return runWithSqliteCoordinator(
    {
      release: () => {
        if (!prepared.cleanup()) {
          throw new Error(`SQLite read-only worker snapshot cleanup failed: ${prepared.location}`);
        }
      },
    },
    "SQLite schema header snapshot",
    () => readSqliteSchemaHeaderSnapshot(prepared.location, signal, agentSchemaVersionForOwnership),
  );
}

/** Async parents join private removal after the native snapshot reader closes. */
export async function readSqliteSchemaHeaderFromSnapshotAsync(
  prepared: PreparedSqliteReadOnlyLocation,
  signal?: AbortSignal,
  agentSchemaVersionForOwnership?: number,
): Promise<SqliteSchemaHeader> {
  let outcome: { value: SqliteSchemaHeader } | { error: unknown };
  try {
    outcome = {
      value: readSqliteSchemaHeaderSnapshot(
        prepared.location,
        signal,
        agentSchemaVersionForOwnership,
      ),
    };
  } catch (error) {
    outcome = { error };
  }
  try {
    if (!(await prepared.cleanupAsync())) {
      throw new Error(`SQLite read-only worker snapshot cleanup failed: ${prepared.location}`);
    }
  } catch (error) {
    if ("error" in outcome) {
      throw createSqliteLifecycleAggregateError(
        [outcome.error, error],
        "SQLite schema header snapshot and coordinator release both failed",
        outcome.error,
      );
    }
    throw new SqliteCoordinatorError(
      "SQLite schema header snapshot completed, but releasing its coordinator failed",
      error,
    );
  }
  if ("error" in outcome) {
    throw outcome.error;
  }
  signal?.throwIfAborted();
  return outcome.value;
}
