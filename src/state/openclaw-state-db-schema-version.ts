import { getPostgresPhysicalFacts } from "../infra/database-engine/physical-facts.js";
import {
  createSqliteQueryCache,
  getNodeSqliteKysely,
  prepareSqliteQuerySync,
} from "../infra/kysely-sync.js";
import type { EngineConnection } from "../infra/sql-connection.js";
import { isPostgresSqlConnection } from "../infra/sql-connection.js";
import { admitSqliteSchema, getAdmittedSqliteSchemaFacts } from "../infra/sqlite-schema-facts.js";
import { SqliteSchemaMismatchError } from "../infra/sqlite-schema-issues.js";
import {
  createNewerSqliteSchemaVersionError,
  isSqliteSchemaVersionError,
  readSqliteUserVersion,
  readSqliteWriterAppVersion,
  type SqliteSchemaErrorContext,
} from "../infra/sqlite-user-version.js";
import {
  getStateSchemaVersionAdmission,
  rememberStateSchemaVersionAdmission,
  type StateSchemaVersionFacts,
} from "./openclaw-state-db-admission.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "./openclaw-state-db-contract.js";
import { tableExists } from "./openclaw-state-db-schema-helpers.js";
import { normalizeOpenClawStateSchemaReadError } from "./openclaw-state-db-schema-migration-required.js";
import type { DB } from "./openclaw-state-db.generated.js";

// Read-only clients need schema admission without loading updater publication policy.
export const CONTENT_VERSION_KEY = "state.schema.contentVersion";
export class PostgresSchemaAdmissionUnavailableError extends Error {}

export function requireStatePostgresPhysicalFacts(database: EngineConnection) {
  const facts = getPostgresPhysicalFacts(database);
  if (!facts) {
    throw new PostgresSchemaAdmissionUnavailableError(
      "Missing PostgreSQL physical schema admission",
    );
  }
  return facts;
}

type StateSchemaVersionDatabase = Pick<DB, "config_machine_state">;
export type StateSchemaContentVersionRowReader = (
  db: EngineConnection,
) => { value_json: string | null; min_reader?: unknown } | undefined;
const contentVersionQuery = createSqliteQueryCache((db) =>
  prepareSqliteQuerySync<void, DB["config_machine_state"] & { min_reader?: unknown }>(db, () =>
    getNodeSqliteKysely<StateSchemaVersionDatabase>(db)
      .selectFrom("config_machine_state")
      .selectAll()
      .where("state_key", "=", CONTENT_VERSION_KEY),
  ),
);

/** Content and its marker commit together, even while older readers retain their version floor. */
export function readStateSchemaContentVersion(
  db: EngineConnection,
  published?: number,
  readRow: StateSchemaContentVersionRowReader = readStateSchemaContentVersionRow,
  physicalUserVersion?: number,
): number {
  const facts = readStateSchemaVersionFacts(db, readRow, physicalUserVersion);
  return Math.max(published ?? facts.userVersion, facts.contentVersion);
}

/** The content-version row owns SQLite's floor; PostgreSQL owns its engine metadata. */
export function readStateSchemaMinReader(db: EngineConnection): number {
  if (isPostgresSqlConnection(db)) {
    const facts = requireStatePostgresPhysicalFacts(db);
    return facts.minReader;
  }
  const facts = readStateSchemaVersionFacts(db);
  return facts.minReader ?? Math.max(facts.userVersion, facts.contentVersion);
}

function readStateSchemaVersionFacts(
  db: EngineConnection,
  readRow: StateSchemaContentVersionRowReader = readStateSchemaContentVersionRow,
  physicalUserVersion?: number,
): StateSchemaVersionFacts {
  const admitted = getStateSchemaVersionAdmission(db);
  if (admitted) {
    return admitted;
  }
  if (isPostgresSqlConnection(db)) {
    throw new PostgresSchemaAdmissionUnavailableError(
      "Missing PostgreSQL state schema admission; use the matching OpenClaw version or restore the matching PostgreSQL schema and anchor.",
    );
  }
  // A caller's publication floor is not the physical header.
  const version =
    physicalUserVersion ??
    getAdmittedSqliteSchemaFacts(db)?.userVersion ??
    readSqliteUserVersion(db);
  const row = tableExists(db, "config_machine_state") ? readRow(db) : undefined;
  const contentVersion = parseStateSchemaContentVersion(row?.value_json);
  const writerVersion = Math.max(version, contentVersion);
  // Combined feature reads predate floor metadata. Only a newer writer needs the
  // extra projection; ordinary current-version reads keep their single query.
  const storedFloor =
    writerVersion > OPENCLAW_STATE_SCHEMA_VERSION && readRow !== readStateSchemaContentVersionRow
      ? readStateSchemaContentVersionRow(db)?.min_reader
      : row?.min_reader;
  const minReader = storedFloor ?? writerVersion;
  if (
    typeof minReader !== "number" ||
    !Number.isSafeInteger(minReader) ||
    minReader < (writerVersion === 0 ? 0 : 1) ||
    minReader > writerVersion
  ) {
    throw new SqliteSchemaMismatchError(
      `Invalid shared state min_reader in ${CONTENT_VERSION_KEY}.`,
    );
  }
  const facts = {
    userVersion: version,
    contentVersion,
    ...(storedFloor == null ? {} : { minReader }),
  };
  rememberStateSchemaVersionAdmission(db, facts);
  return facts;
}

export function readStateSchemaContentVersionRow(db: EngineConnection) {
  return contentVersionQuery(db)().rows[0];
}

export function parseStateSchemaContentVersion(valueJson: string | null | undefined): number {
  if (valueJson === undefined) {
    return 0;
  }
  let contentVersion: unknown;
  try {
    contentVersion = valueJson === null ? null : JSON.parse(valueJson);
  } catch (cause) {
    throw new SqliteSchemaMismatchError(
      `Invalid shared state schema content version in ${CONTENT_VERSION_KEY}.`,
      { cause },
    );
  }
  if (
    typeof contentVersion !== "number" ||
    !Number.isSafeInteger(contentVersion) ||
    contentVersion < 0
  ) {
    throw new SqliteSchemaMismatchError(
      `Invalid shared state schema content version in ${CONTENT_VERSION_KEY}.`,
    );
  }
  return contentVersion;
}

export type { StateSchemaVersionFacts } from "./openclaw-state-db-admission.js";

/** Check the reader floor before catalog inspection, then share one physical schema capture. */
export function admitStateSchemaFacts(
  database: EngineConnection,
  pathname: string,
  context: SqliteSchemaErrorContext = "runtime",
): void {
  if (isPostgresSqlConnection(database)) {
    requireStatePostgresPhysicalFacts(database);
    return;
  }
  try {
    admitSqliteSchema(database, (userVersion) => {
      if (userVersion > OPENCLAW_STATE_SCHEMA_VERSION) {
        assertSupportedStateSchemaVersion(
          database,
          pathname,
          { userVersion, contentVersion: userVersion },
          undefined,
          context,
        );
      }
    });
  } catch (error) {
    if (isSqliteSchemaVersionError(error)) {
      throw error;
    }
    // An unreadable newer catalog must not become advice to repair it with T.
    let version: number;
    try {
      version = readSqliteUserVersion(database);
    } catch {
      throw normalizeOpenClawStateSchemaReadError(error, pathname);
    }
    if (
      version > OPENCLAW_STATE_SCHEMA_VERSION &&
      (getStateSchemaVersionAdmission(database)?.minReader ?? version) >
        OPENCLAW_STATE_SCHEMA_VERSION
    ) {
      throw createNewerSqliteSchemaVersionError(
        "OpenClaw state database",
        pathname,
        version,
        OPENCLAW_STATE_SCHEMA_VERSION,
        readSqliteWriterAppVersion(database),
        context,
      );
    }
    throw normalizeOpenClawStateSchemaReadError(error, pathname);
  }
}

export function assertSupportedStateSchemaVersion(
  db: EngineConnection,
  pathname: string,
  prepared?: StateSchemaVersionFacts,
  readRow?: StateSchemaContentVersionRowReader,
  context: SqliteSchemaErrorContext = "runtime",
): number {
  let userVersion = prepared?.userVersion;
  try {
    userVersion ??=
      getStateSchemaVersionAdmission(db)?.userVersion ??
      (isPostgresSqlConnection(db)
        ? requireStatePostgresPhysicalFacts(db).version
        : (getAdmittedSqliteSchemaFacts(db)?.userVersion ?? readSqliteUserVersion(db)));
    const facts = readStateSchemaVersionFacts(db, readRow, userVersion);
    const contentVersion = Math.max(userVersion, facts.contentVersion);
    const minReader = facts.minReader ?? contentVersion;
    if (minReader > OPENCLAW_STATE_SCHEMA_VERSION) {
      const error = createNewerSqliteSchemaVersionError(
        "OpenClaw state database",
        pathname,
        contentVersion,
        OPENCLAW_STATE_SCHEMA_VERSION,
        readSqliteWriterAppVersion(db),
        context,
      );
      error.message += ` Minimum reader schema version is ${minReader}.`;
      throw error;
    }
    return userVersion;
  } catch (error) {
    if (
      !isPostgresSqlConnection(db) &&
      !isSqliteSchemaVersionError(error) &&
      userVersion !== undefined &&
      userVersion > OPENCLAW_STATE_SCHEMA_VERSION
    ) {
      throw createNewerSqliteSchemaVersionError(
        "OpenClaw state database",
        pathname,
        userVersion,
        OPENCLAW_STATE_SCHEMA_VERSION,
        readSqliteWriterAppVersion(db),
        context,
      );
    }
    throw normalizeOpenClawStateSchemaReadError(error, pathname);
  }
}
