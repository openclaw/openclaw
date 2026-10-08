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
export function readStateSchemaContentVersion(db: DatabaseSync, published?: number): number {
  const schema = getAdmittedSqliteSchemaFacts(db);
  const version = published ?? schema?.userVersion ?? readSqliteUserVersion(db);
  const revision = getSqliteReadOperationRevision(db);
  const admitted = admittedContentVersions.get(db);
  if (
    revision &&
    admitted?.schema === revision.schema &&
    admitted.dataVersion === revision.dataVersion &&
    admitted.mutationRevision === revision.mutationRevision
  ) {
    return Math.max(version, admitted.contentVersion);
  }
  // A caller-provided version floor belongs to this read, not the retained marker.
  const contentVersion = readContentVersionMarker(db);
  if (revision && getSqliteReadOperationRevision(db) === revision) {
    if (!admitted) {
      const unregister = registerNodeSqliteDisposeCallback(db, () => {
        admittedContentVersions.delete(db);
        unregister();
      });
    }
    admittedContentVersions.set(db, { ...revision, contentVersion });
  }
  return Math.max(version, contentVersion);
}

function readContentVersionMarker(db: DatabaseSync): number {
  if (!tableExists(db, "config_machine_state")) {
    return 0;
  }
  const row = contentVersionQuery(db)().rows[0];
  if (!row) {
    return 0;
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
  return contentVersion;
}

/** Valid only for the unchanged read snapshot that produced these versions. */
export type StateSchemaVersionFacts = { userVersion: number; contentVersion: number };

export function assertSupportedStateSchemaVersion(
  db: DatabaseSync,
  pathname: string,
  prepared?: StateSchemaVersionFacts,
): number {
  try {
    const userVersion =
      prepared?.userVersion ??
      getAdmittedSqliteSchemaFacts(db)?.userVersion ??
      readSqliteUserVersion(db);
    const contentVersion =
      prepared?.contentVersion ??
      (userVersion > OPENCLAW_STATE_SCHEMA_VERSION
        ? userVersion
        : readStateSchemaContentVersion(db, userVersion));
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
