import type { DatabaseSync } from "node:sqlite";
import type { DB as OpenClawAgentKyselyDatabase } from "../state/openclaw-agent-db.generated.js";
import { OPENCLAW_DATABASE_SCHEMA_DOCS_URL } from "../state/openclaw-state-db-contract.js";
import { resolveRuntimeServiceCommit, VERSION } from "../version.js";
import { executeSqliteQueryTakeFirstSync, getNodeSqliteKysely } from "./kysely-sync.js";
import { resolveOpenClawPackageRootSync } from "./openclaw-root.js";
import { runSqliteDeferredTransactionSync } from "./sqlite-transaction.js";
import { StartupMaintenanceRequiredError } from "./startup-maintenance-required.js";

type SqliteUserVersionReader = {
  prepare: (sql: string) => { get: () => unknown };
};

export type SqliteSchemaHeader = {
  userVersion: number;
  writerAppVersion?: string;
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

/** Read both metadata values from one fresh SQLite read transaction, including WAL. */
export function readSqliteSchemaHeader(database: DatabaseSync): SqliteSchemaHeader {
  database.exec("PRAGMA query_only = ON; PRAGMA trusted_schema = OFF;");
  return runSqliteDeferredTransactionSync(database, () => {
    const userVersion = readSqliteUserVersion(database);
    const writerAppVersion = readSqliteWriterAppVersion(database);
    return { userVersion, ...(writerAppVersion ? { writerAppVersion } : {}) };
  });
}

const SQLITE_SCHEMA_VERSION_ERROR_NAME = "SqliteSchemaVersionError";

export class SqliteSchemaVersionError extends StartupMaintenanceRequiredError {
  override name = SQLITE_SCHEMA_VERSION_ERROR_NAME;

  constructor(message: string) {
    super("newer-schema", message);
  }
}

export function isSqliteSchemaVersionError(error: unknown): error is Error {
  return (
    error instanceof SqliteSchemaVersionError ||
    (error instanceof Error && error.name === SQLITE_SCHEMA_VERSION_ERROR_NAME)
  );
}

export function readSqliteUserVersion(db: SqliteUserVersionReader): number {
  const row = db.prepare("PRAGMA user_version").get() as { user_version?: unknown } | undefined;
  return Number(row?.user_version ?? 0);
}

/**
 * Name the refusing build from immutable loaded metadata, plus its install root.
 * The path remains actionable when multiple installs share a version or build.
 */
export function describeRunningOpenClawBuild(): string {
  const commit = resolveRuntimeServiceCommit();
  const root = resolveOpenClawPackageRootSync({ moduleUrl: import.meta.url });
  const identity = commit ? `OpenClaw ${VERSION} (${commit})` : `OpenClaw ${VERSION}`;
  return root ? `${identity} installed at ${root}` : identity;
}

export function createNewerSqliteSchemaVersionError(
  databaseLabel: string,
  pathname: string,
  schemaVersion: number,
  supportedVersion: number,
): Error {
  return new SqliteSchemaVersionError(
    "This OpenClaw build cannot open your existing data.\n" +
      `${databaseLabel} ${pathname} uses newer schema version ${schemaVersion}; this build supports ${supportedVersion}.\n` +
      `Refused by ${describeRunningOpenClawBuild()}.\n` +
      `Use a build that supports schema ${schemaVersion} or newer with this state directory. To use an older build, restore your pre-update backup created with openclaw backup.\n` +
      `See ${OPENCLAW_DATABASE_SCHEMA_DOCS_URL}.`,
  );
}
