import type { DatabaseSync } from "node:sqlite";
import {
  createSqliteQueryCache,
  getNodeSqliteKysely,
  prepareSqliteQuerySync,
} from "../infra/kysely-sync.js";
import { getAdmittedSqliteSchemaFacts } from "../infra/sqlite-schema-facts.js";
import { SqliteSchemaMismatchError } from "../infra/sqlite-schema-issues.js";
import {
  createNewerSqliteSchemaVersionError,
  readSqliteUserVersion,
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
type StateSchemaVersionDatabase = Pick<DB, "config_machine_state">;
export type StateSchemaContentVersionRowReader = (
  db: DatabaseSync,
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
  db: DatabaseSync,
  published?: number,
  readRow: StateSchemaContentVersionRowReader = readStateSchemaContentVersionRow,
): number {
  const admitted = getStateSchemaVersionAdmission(db);
  if (admitted) {
    return Math.max(published ?? admitted.userVersion, admitted.contentVersion);
  }
  const schema = getAdmittedSqliteSchemaFacts(db);
  const version = schema?.userVersion ?? readSqliteUserVersion(db);
  const contentVersion = parseContentVersion(
    tableExists(db, "config_machine_state") ? readRow(db)?.value_json : undefined,
  );
  rememberStateSchemaVersionAdmission(db, { userVersion: version, contentVersion });
  return Math.max(published ?? version, contentVersion);
}

export function readStateSchemaContentVersionRow(db: DatabaseSync) {
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

export function assertSupportedStateSchemaVersion(
  db: DatabaseSync,
  pathname: string,
  prepared?: StateSchemaVersionFacts,
  readRow?: StateSchemaContentVersionRowReader,
): number {
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
        : readStateSchemaContentVersion(db, userVersion, readRow));
    if (contentVersion > OPENCLAW_STATE_SCHEMA_VERSION) {
      throw createNewerSqliteSchemaVersionError(
        "OpenClaw state database",
        pathname,
        contentVersion,
        OPENCLAW_STATE_SCHEMA_VERSION,
      );
    }
    return userVersion;
  } catch (error) {
    throw normalizeOpenClawStateSchemaReadError(error, pathname);
  }
}
