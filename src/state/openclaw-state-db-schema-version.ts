import type { DatabaseSync } from "node:sqlite";
import { getNodeSqliteKysely, prepareSqliteQuerySync } from "../infra/kysely-sync.js";
import { collectSqliteSchemaIssues } from "../infra/sqlite-schema-contract.js";
import {
  createNewerSqliteSchemaVersionError,
  readSqliteUserVersion,
} from "../infra/sqlite-user-version.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "./openclaw-state-db-contract.js";
import { tableExists, tableHasColumn } from "./openclaw-state-db-schema-helpers.js";
import type { DB } from "./openclaw-state-db.generated.js";

// Read-only clients need schema admission without loading updater publication policy.
export const CONTENT_VERSION_KEY = "state.schema.contentVersion";
type StateSchemaVersionDatabase = Pick<DB, "config_machine_state">;
// Admission also runs on cached reads. Retain the SQL, never the content version.
const contentVersionQueries = new WeakMap<
  DatabaseSync,
  ReturnType<typeof prepareSqliteQuerySync<void, Pick<DB["config_machine_state"], "value_json">>>
>();

/** Content and its marker commit together, even while older readers retain their version floor. */
export function readStateSchemaContentVersion(db: DatabaseSync): number {
  const published = readSqliteUserVersion(db);
  if (!tableExists(db, "config_machine_state")) {
    return published;
  }
  let query = contentVersionQueries.get(db);
  if (!query) {
    query = prepareSqliteQuerySync(db, () =>
      getNodeSqliteKysely<StateSchemaVersionDatabase>(db)
        .selectFrom("config_machine_state")
        .select("value_json")
        .where("state_key", "=", CONTENT_VERSION_KEY),
    );
    contentVersionQueries.set(db, query);
  }
  const row = query().rows[0];
  if (!row) {
    return published;
  }
  const contentVersion: unknown = JSON.parse(row.value_json);
  if (
    typeof contentVersion !== "number" ||
    !Number.isSafeInteger(contentVersion) ||
    contentVersion < 0
  ) {
    throw new Error(`Invalid shared state schema content version in ${CONTENT_VERSION_KEY}.`);
  }
  return Math.max(published, contentVersion);
}

/** Cold migration planning checks physical content; admission still uses the recorded version. */
export function readStateSchemaMigrationVersion(db: DatabaseSync): number {
  const version = readStateSchemaContentVersion(db);
  if (version !== 16) {
    return version;
  }
  const reviewWorkspace = tableHasColumn(db, "skill_workshop_collection_reviews", "workspace_dir");
  const proposalWorkspace = tableHasColumn(db, "skill_workshop_proposals", "workspace_dir");
  const releasedClaim = tableHasColumn(db, "skill_workshop_proposals", "claim_released_time");
  if (!reviewWorkspace && !proposalWorkspace && !releasedClaim) {
    return version;
  }
  // Review attribution needs the old proposal workspace mapping. Never guess it from a mixed pair.
  const missingAttribution = reviewWorkspace && !proposalWorkspace;
  const schema = `
    CREATE TABLE skill_workshop_collection_reviews (
      review_id TEXT NOT NULL PRIMARY KEY,
      ${reviewWorkspace ? "workspace_dir" : "owner_agent_id"} TEXT NOT NULL,
      backup_id TEXT NOT NULL,
      create_time INTEGER NOT NULL,
      kept_names_json TEXT NOT NULL,
      written_names_json TEXT NOT NULL,
      dropped_json TEXT NOT NULL
    ) STRICT;
    CREATE TABLE skill_workshop_proposals (
      proposal_id TEXT NOT NULL PRIMARY KEY,
      record_json TEXT NOT NULL,
      owner_agent_id TEXT,
      ${proposalWorkspace ? "workspace_dir TEXT NOT NULL," : ""}
      kind TEXT NOT NULL CHECK (kind IN ('create', 'update')),
      status TEXT NOT NULL CHECK (status IN ('pending', 'applied', 'rejected', 'quarantined', 'stale')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      draft_hash TEXT NOT NULL,
      origin_agent_id TEXT,
      origin_session_key TEXT,
      origin_run_id TEXT,
      origin_message_id TEXT,
      applied_at TEXT,
      rejected_at TEXT,
      quarantined_at TEXT,
      stale_at TEXT,
      status_reason TEXT
      ${releasedClaim ? ", claim_released_time INTEGER" : ""}
    ) STRICT;
  `;
  const issues = collectSqliteSchemaIssues(db, schema, {
    allowedMissingTables: ["skill_workshop_collection_reviews"],
    allowedColumnDefinitions: {
      "skill_workshop_collection_reviews.workspace_dir": ["workspace_dir TEXT NOT NULL DEFAULT ''"],
      "skill_workshop_proposals.workspace_dir": ["workspace_dir TEXT NOT NULL DEFAULT ''"],
    },
  });
  if (!missingAttribution && issues.length === 0) {
    return 15;
  }
  throw new Error(
    "Unrecognized Skill Workshop ownership schema; cannot apply the schema 16 migration.",
  );
}

export function assertSupportedStateSchemaVersion(db: DatabaseSync, pathname: string): number {
  const userVersion = readSqliteUserVersion(db);
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
}
