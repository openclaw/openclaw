import type { DatabaseSync } from "node:sqlite";
import { compareOpenClawVersions } from "../config/version.js";
import { OPENCLAW_DATABASE_SCHEMA_DOCS_URL } from "../state/openclaw-state-db-contract.js";
import { resolveRuntimeServiceCommit, VERSION } from "../version.js";
import { executeWithCachedStatement } from "./kysely-sync-cache-state.js";
import { resolveOpenClawPackageRootSync } from "./openclaw-root.js";
import type { EngineConnection } from "./sql-connection.js";
import { StartupMaintenanceRequiredError } from "./startup-maintenance-required.js";

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

export function readSqliteUserVersion(db: DatabaseSync): number {
  const row = executeWithCachedStatement(db, "PRAGMA user_version", [], (statement) =>
    statement.get(),
  );
  return Number(row?.user_version ?? 0);
}

export function readSqliteWriterAppVersion(database: EngineConnection): string | undefined {
  try {
    // Schema inspection stays independent of Kysely's runtime graph so even native startup can refuse.
    const row = executeWithCachedStatement(
      database,
      "SELECT app_version FROM schema_meta WHERE meta_key = 'primary' LIMIT 1",
      [],
      (statement) => statement.get(),
    );
    return typeof row?.app_version === "string" && row.app_version.length > 0
      ? row.app_version
      : undefined;
  } catch {
    return undefined;
  }
}

export function writeSqliteUserVersion(db: DatabaseSync, version: number): void {
  if (!Number.isInteger(version) || version < 0 || version > 2147483647) {
    throw new RangeError("SQLite user_version must be an integer from 0 through 2147483647.");
  }
  db.exec(`PRAGMA user_version = ${version}`);
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

export function isNewerSqliteWriterVersion(writerAppVersion: string | undefined): boolean {
  return (compareOpenClawVersions(writerAppVersion, VERSION) ?? 0) > 0;
}

export function createNewerSqliteSchemaVersionError(
  databaseLabel: string,
  pathname: string,
  schemaVersion: number,
  supportedVersion: number,
  writerAppVersion?: string,
): Error {
  const newerWriter = isNewerSqliteWriterVersion(writerAppVersion);
  return new SqliteSchemaVersionError(
    "This OpenClaw build cannot open your existing data.\n" +
      `${databaseLabel} ${pathname} uses newer schema version ${schemaVersion}; this build supports ${supportedVersion}.\n` +
      (writerAppVersion
        ? `It was written by OpenClaw ${writerAppVersion}; ${newerWriter ? `it is newer than this Gateway (${VERSION}).` : "run openclaw doctor --fix to inspect this database."}\n`
        : "") +
      `Refused by ${describeRunningOpenClawBuild()}.\n` +
      (newerWriter
        ? `Use the newer install that supports schema ${schemaVersion} or newer, or run openclaw update to update this Gateway service before restarting. To use an older build, restore your pre-update backup created with openclaw backup create.\n`
        : `Use a build that supports schema ${schemaVersion} or newer with this state directory. To use an older build, restore your pre-update backup created with openclaw backup create.\n`) +
      `See ${OPENCLAW_DATABASE_SCHEMA_DOCS_URL}.`,
  );
}
