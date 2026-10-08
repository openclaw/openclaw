import type { DatabaseSync } from "node:sqlite";
import { registerNodeSqliteDisposeCallback } from "../infra/kysely-sync-cache-state.js";
import {
  createSqliteQueryCache,
  getNodeSqliteKysely,
  prepareSqliteQuerySync,
} from "../infra/kysely-sync.js";
import {
  getAdmittedSqliteSchemaFacts,
  getSqliteReadOperationRevision,
  type SqliteReadOperationRevision,
} from "../infra/sqlite-schema-facts.js";
import { SqliteSchemaMismatchError } from "../infra/sqlite-schema-issues.js";
import {
  createNewerSqliteSchemaVersionError,
  readSqliteUserVersion,
} from "../infra/sqlite-user-version.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "./openclaw-state-db-contract.js";
import { tableExists } from "./openclaw-state-db-schema-helpers.js";
import { normalizeOpenClawStateSchemaReadError } from "./openclaw-state-db-schema-migration-required.js";
import type { DB } from "./openclaw-state-db.generated.js";

// Read-only clients need schema admission without loading updater publication policy.
export const CONTENT_VERSION_KEY = "state.schema.contentVersion";
type StateSchemaVersionDatabase = Pick<DB, "config_machine_state">;
const admittedContentVersions = new WeakMap<
  DatabaseSync,
  SqliteReadOperationRevision & { contentVersion: number }
>();
const contentVersionQuery = createSqliteQueryCache((db) =>
  prepareSqliteQuerySync<void, Pick<DB["config_machine_state"], "value_json">>(db, () =>
    getNodeSqliteKysely<StateSchemaVersionDatabase>(db)
      .selectFrom("config_machine_state")
      .select("value_json")
      .where("state_key", "=", CONTENT_VERSION_KEY),
  ),
);

/** Content and its marker commit together, even while older readers retain their version floor. */
export function readStateSchemaContentVersion(db: DatabaseSync): number {
  const schema = getAdmittedSqliteSchemaFacts(db);
  const revision = getSqliteReadOperationRevision(db);
  const admitted = admittedContentVersions.get(db);
  if (
    revision &&
    admitted?.schema === revision.schema &&
    admitted.dataVersion === revision.dataVersion &&
    admitted.mutationRevision === revision.mutationRevision
  ) {
    return admitted.contentVersion;
  }
  const contentVersion = readContentVersion(db, schema?.userVersion ?? readSqliteUserVersion(db));
  if (revision && getSqliteReadOperationRevision(db) === revision) {
    if (!admitted) {
      const unregister = registerNodeSqliteDisposeCallback(db, () => {
        admittedContentVersions.delete(db);
        unregister();
      });
    }
    admittedContentVersions.set(db, { ...revision, contentVersion });
  }
  return contentVersion;
}

function readContentVersion(db: DatabaseSync, published: number): number {
  if (!tableExists(db, "config_machine_state")) {
    return published;
  }
  const row = contentVersionQuery(db)().rows[0];
  if (!row) {
    return published;
  }
  let contentVersion: unknown;
  try {
    contentVersion = JSON.parse(row.value_json);
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
  return Math.max(published, contentVersion);
}

export function assertSupportedStateSchemaVersion(db: DatabaseSync, pathname: string): number {
  try {
    const userVersion = getAdmittedSqliteSchemaFacts(db)?.userVersion ?? readSqliteUserVersion(db);
    const contentVersion =
      userVersion > OPENCLAW_STATE_SCHEMA_VERSION ? userVersion : readStateSchemaContentVersion(db);
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
