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
type StateSchemaVersionDatabase = Pick<DB, "config_machine_state">;
export type StateSchemaContentVersionRowReader = (
  db: EngineConnection,
) => { value_json: string | null } | undefined;
const contentVersionQuery = createSqliteQueryCache((db) =>
  prepareSqliteQuerySync<void, Pick<DB["config_machine_state"], "value_json">>(db, () =>
    getNodeSqliteKysely<StateSchemaVersionDatabase>(db)
      .selectFrom("config_machine_state")
      .select("value_json")
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
  if (isPostgresSqlConnection(db)) {
    const facts = getStateSchemaVersionAdmission(db);
    if (!facts) {
      throw new PostgresSchemaAdmissionUnavailableError(
        "Missing PostgreSQL state schema admission; use the matching OpenClaw version or restore the matching PostgreSQL schema and anchor.",
      );
    }
    return Math.max(published ?? facts.userVersion, facts.contentVersion);
  }
  const admitted = getStateSchemaVersionAdmission(db);
  if (admitted) {
    return Math.max(published ?? admitted.userVersion, admitted.contentVersion);
  }
  // A caller's publication floor is not the physical header.
  const version =
    physicalUserVersion ??
    getAdmittedSqliteSchemaFacts(db)?.userVersion ??
    readSqliteUserVersion(db);
  const contentVersion = parseContentVersion(
    tableExists(db, "config_machine_state") ? readRow(db)?.value_json : undefined,
  );
  rememberStateSchemaVersionAdmission(db, { userVersion: version, contentVersion });
  return Math.max(published ?? version, contentVersion);
}

export function readStateSchemaContentVersionRow(db: EngineConnection) {
  return contentVersionQuery(db)().rows[0];
}

function parseContentVersion(valueJson: string | null | undefined): number {
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

/** Refuse newer headers before catalog inspection, then share one physical schema capture. */
export function admitStateSchemaFacts(
  database: EngineConnection,
  pathname: string,
  context: SqliteSchemaErrorContext = "runtime",
): void {
  if (isPostgresSqlConnection(database)) {
    if (!getPostgresPhysicalFacts(database)) {
      throw new PostgresSchemaAdmissionUnavailableError(
        "Missing PostgreSQL physical schema admission",
      );
    }
    return;
  }
  try {
    admitSqliteSchema(database, (userVersion) =>
      assertSupportedStateSchemaVersion(
        database,
        pathname,
        { userVersion, contentVersion: userVersion },
        undefined,
        context,
      ),
    );
  } catch (error) {
    // An unreadable newer catalog must not be mistaken for a repair this build can perform.
    let version: number;
    try {
      version = readSqliteUserVersion(database);
    } catch {
      throw normalizeOpenClawStateSchemaReadError(error, pathname);
    }
    if (version > OPENCLAW_STATE_SCHEMA_VERSION) {
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
  if (isPostgresSqlConnection(db)) {
    return readStateSchemaContentVersion(db);
  }
  try {
    const userVersion =
      prepared?.userVersion ??
      getStateSchemaVersionAdmission(db)?.userVersion ??
      getAdmittedSqliteSchemaFacts(db)?.userVersion ??
      readSqliteUserVersion(db);
    const contentVersion =
      prepared?.contentVersion ??
      (userVersion > OPENCLAW_STATE_SCHEMA_VERSION
        ? userVersion
        : readStateSchemaContentVersion(db, userVersion, readRow, userVersion));
    if (contentVersion > OPENCLAW_STATE_SCHEMA_VERSION) {
      throw createNewerSqliteSchemaVersionError(
        "OpenClaw state database",
        pathname,
        contentVersion,
        OPENCLAW_STATE_SCHEMA_VERSION,
        readSqliteWriterAppVersion(db),
        context,
      );
    }
    return userVersion;
  } catch (error) {
    throw normalizeOpenClawStateSchemaReadError(error, pathname);
  }
}
