import { extractSqliteTableSchema } from "../infra/sqlite-schema-sql.js";
import { withoutAgentColdArchiveChunks } from "./openclaw-agent-cold-archive-chunks-schema.js";
import { withoutAgentColdNavigation } from "./openclaw-agent-cold-navigation-schema.js";
import {
  AGENT_COLD_ARCHIVE_CHUNKS_SCHEMA_VERSION,
  AGENT_COLD_NAVIGATION_SCHEMA_VERSION,
  AGENT_INDEX_RETIREMENT_SCHEMA_VERSION,
  AGENT_JSON_PREDICATE_SCHEMA_VERSION,
  AGENT_MEMORY_REVISION_SCHEMA_VERSION,
  AGENT_OUTBOX_SEQUENCE_SCHEMA_VERSION,
  AGENT_STORAGE_SCHEMA_VERSION,
  AGENT_WRITE_LAYOUT_SCHEMA_VERSION,
  AGENT_TRAJECTORY_STORAGE_SCHEMA_VERSION,
  CANONICAL_SESSION_VALIDATION_SCHEMA_VERSION,
  CANONICAL_SESSION_WRITER_VALIDATION_SCHEMA_VERSION,
  SESSION_PARTICIPANTS_TABLE,
} from "./openclaw-agent-db-contract.js";
import { withLegacyAgentIndexes } from "./openclaw-agent-index-retirement-migration.js";
import { withLegacyAgentMemoryRevisionTriggers } from "./openclaw-agent-memory-revision-migration.js";
import { OPENCLAW_AGENT_SCHEMA_SQL } from "./openclaw-agent-schema.js";
import {
  SESSION_ENTRY_SNAPSHOTS_SCHEMA_VERSION,
  withoutSessionEntrySnapshotsSchema,
} from "./openclaw-agent-session-snapshots-schema.js";
import { withLegacyAgentStorageSchema } from "./openclaw-agent-storage-schema.js";
import { withoutTrajectoryPayloadColumns } from "./openclaw-agent-trajectory-storage-migration.js";

// Schema 21–24 kept every raw writer observable through this required trigger group.
export const LEGACY_ENTRY_VALIDITY_TRIGGERS_SQL = `
CREATE TRIGGER IF NOT EXISTS session_nodes_entry_valid_after_insert
AFTER INSERT ON session_nodes
BEGIN
  UPDATE session_nodes SET entry_valid = 0 WHERE session_key = NEW.session_key;
END;

CREATE TRIGGER IF NOT EXISTS session_nodes_entry_valid_after_entry_update
AFTER UPDATE OF entry_json ON session_nodes
BEGIN
  UPDATE session_nodes SET entry_valid = 0 WHERE session_key = NEW.session_key;
END;

CREATE TRIGGER IF NOT EXISTS session_nodes_entry_valid_after_identity_update
AFTER UPDATE OF current_session_id, updated_at ON session_nodes
BEGIN
  UPDATE session_nodes SET entry_valid = 0 WHERE session_key = NEW.session_key;
END;
`;
const LEGACY_CANONICAL_PENDING_TRIGGERS_SQL = `
-- Avoid trigger-local conflict clauses: SQLite inherits the outer writer's
-- conflict policy, including writers that predate this validation projection.
CREATE TRIGGER IF NOT EXISTS session_nodes_canonical_pending_after_insert
AFTER INSERT ON session_nodes
BEGIN
  INSERT INTO session_canonical_validation_pending (session_key)
  SELECT NEW.session_key
  WHERE NOT EXISTS (
    SELECT 1 FROM session_canonical_validation_pending WHERE session_key = NEW.session_key
  );
END;

CREATE TRIGGER IF NOT EXISTS session_nodes_canonical_pending_after_update
AFTER UPDATE OF session_key, current_session_id, entry_json, entry_valid,
  parent_session_key, spawned_by, fork_source_session_key ON session_nodes
WHEN OLD.session_key IS NOT NEW.session_key
  OR OLD.current_session_id IS NOT NEW.current_session_id
  OR OLD.entry_json IS NOT NEW.entry_json
  OR OLD.entry_valid IS NOT NEW.entry_valid
  OR OLD.parent_session_key IS NOT NEW.parent_session_key
  OR OLD.spawned_by IS NOT NEW.spawned_by
  OR OLD.fork_source_session_key IS NOT NEW.fork_source_session_key
BEGIN
  DELETE FROM session_canonical_validation_pending
  WHERE session_key = OLD.session_key AND OLD.session_key IS NOT NEW.session_key;
  INSERT INTO session_canonical_validation_pending (session_key)
  SELECT NEW.session_key
  WHERE NOT EXISTS (
    SELECT 1 FROM session_canonical_validation_pending WHERE session_key = NEW.session_key
  );
END;

CREATE TRIGGER IF NOT EXISTS session_nodes_canonical_pending_after_delete
AFTER DELETE ON session_nodes
BEGIN
  DELETE FROM session_canonical_validation_pending WHERE session_key = OLD.session_key;
END;

CREATE TRIGGER IF NOT EXISTS session_windows_canonical_pending_after_insert
AFTER INSERT ON session_windows
BEGIN
  INSERT INTO session_canonical_validation_pending (session_key)
  SELECT node.session_key FROM session_nodes AS node
  WHERE node.current_session_id = NEW.session_id
    AND NOT EXISTS (
      SELECT 1 FROM session_canonical_validation_pending AS pending
      WHERE pending.session_key = node.session_key
    );
END;

CREATE TRIGGER IF NOT EXISTS session_windows_canonical_pending_after_update
AFTER UPDATE OF session_id, session_key ON session_windows
WHEN OLD.session_id IS NOT NEW.session_id OR OLD.session_key IS NOT NEW.session_key
BEGIN
  INSERT INTO session_canonical_validation_pending (session_key)
  SELECT node.session_key FROM session_nodes AS node
  WHERE node.current_session_id IN (OLD.session_id, NEW.session_id)
    AND NOT EXISTS (
      SELECT 1 FROM session_canonical_validation_pending AS pending
      WHERE pending.session_key = node.session_key
    );
END;

CREATE TRIGGER IF NOT EXISTS session_windows_canonical_pending_after_delete
AFTER DELETE ON session_windows
BEGIN
  INSERT INTO session_canonical_validation_pending (session_key)
  SELECT node.session_key FROM session_nodes AS node
  WHERE node.current_session_id = OLD.session_id
    AND NOT EXISTS (
      SELECT 1 FROM session_canonical_validation_pending AS pending
      WHERE pending.session_key = node.session_key
    );
END;

CREATE TRIGGER IF NOT EXISTS session_key_contract_canonical_pending_after_insert
AFTER INSERT ON session_key_contract
BEGIN
  INSERT INTO session_canonical_validation_pending (session_key)
  SELECT node.session_key FROM session_nodes AS node
  WHERE NOT EXISTS (
    SELECT 1 FROM session_canonical_validation_pending AS pending
    WHERE pending.session_key = node.session_key
  );
END;

CREATE TRIGGER IF NOT EXISTS session_key_contract_canonical_pending_after_update
AFTER UPDATE OF main_key ON session_key_contract
WHEN OLD.main_key IS NOT NEW.main_key
BEGIN
  INSERT INTO session_canonical_validation_pending (session_key)
  SELECT node.session_key FROM session_nodes AS node
  WHERE NOT EXISTS (
    SELECT 1 FROM session_canonical_validation_pending AS pending
    WHERE pending.session_key = node.session_key
  );
END;

CREATE TRIGGER IF NOT EXISTS session_key_contract_canonical_pending_after_delete
AFTER DELETE ON session_key_contract
BEGIN
  INSERT INTO session_canonical_validation_pending (session_key)
  SELECT node.session_key FROM session_nodes AS node
  WHERE NOT EXISTS (
    SELECT 1 FROM session_canonical_validation_pending AS pending
    WHERE pending.session_key = node.session_key
  );
END;
`;

/** Historical preflight compares the trigger contract those releases actually wrote. */
function withLegacyCanonicalSessionValidationTriggers(schema: string): string {
  return schema
    .replace(
      "CREATE TABLE IF NOT EXISTS session_windows (",
      `${LEGACY_ENTRY_VALIDITY_TRIGGERS_SQL}\nCREATE TABLE IF NOT EXISTS session_windows (`,
    )
    .replace(
      "CREATE TABLE IF NOT EXISTS conversations (",
      `${LEGACY_CANONICAL_PENDING_TRIGGERS_SQL}\nCREATE TABLE IF NOT EXISTS conversations (`,
    );
}

export const LEGACY_CANONICAL_VALIDATION_TRIGGER_NAMES = Object.freeze(
  [
    ...`${LEGACY_ENTRY_VALIDITY_TRIGGERS_SQL}\n${LEGACY_CANONICAL_PENDING_TRIGGERS_SQL}`.matchAll(
      /CREATE TRIGGER IF NOT EXISTS (\w+)/gu,
    ),
  ].map((match) => match[1]!),
);

/** The schema owner installs the pending queue before seeding imported keys. */
export function canonicalSessionValidationSchemaSql(schema = OPENCLAW_AGENT_SCHEMA_SQL): string {
  return extractSqliteTableSchema(schema, "session_canonical_validation_pending", {
    endMarker: "CREATE TABLE IF NOT EXISTS conversations (",
    includeEndMarker: false,
  });
}

/** Historical migration preflights cannot require the schema-21 validation projection. */
function withoutCanonicalSessionValidationSchema(schema: string): string {
  if (!schema.includes("CREATE TABLE IF NOT EXISTS session_canonical_validation_pending (")) {
    return schema;
  }
  return schema.replace(canonicalSessionValidationSchemaSql(schema), "");
}

/** Derived fields introduced together by agent schema 26. JSON remains canonical. */
export const AGENT_JSON_PREDICATE_COLUMNS = {
  session_nodes: ["session_started_at", "has_optional_references"],
  transcript_events: [
    "navigation_type",
    "navigation_custom_type",
    "navigation_display",
    "message_role",
    "navigation_last_type",
    "navigation_last_custom_type",
    "navigation_valid",
  ],
  context_engine_turn_outbox: ["payload_state"],
} as const;

export const AGENT_JSON_PREDICATE_COLUMN_DECLARATIONS = {
  session_started_at: "INTEGER",
  has_optional_references: "INTEGER NOT NULL DEFAULT 0",
  payload_state: "TEXT",
  navigation_type: "TEXT",
  navigation_custom_type: "TEXT",
  navigation_display: "INTEGER NOT NULL DEFAULT 0",
  message_role: "TEXT",
  navigation_last_type: "TEXT",
  navigation_last_custom_type: "TEXT",
  navigation_valid: "INTEGER NOT NULL DEFAULT 1",
};

/** Historical admission compares the schema before predicate columns existed. */
function withoutAgentJsonPredicateColumns(schema: string): string {
  let historicalSchema = schema;
  for (const [column, declaration] of Object.entries(AGENT_JSON_PREDICATE_COLUMN_DECLARATIONS)) {
    historicalSchema = historicalSchema.replace(`  ${column} ${declaration},\n`, "");
  }
  return historicalSchema;
}

export const LEGACY_PARTICIPANTS_SCHEMA = `CREATE TABLE IF NOT EXISTS session_participants (
  session_key TEXT NOT NULL,
  actor_type TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  actor_source TEXT,
  contribution_count INTEGER,
  first_prompted_at INTEGER NOT NULL,
  last_prompted_at INTEGER NOT NULL,
  PRIMARY KEY (session_key, actor_type, actor_id),
  FOREIGN KEY (session_key) REFERENCES session_nodes(session_key) ON DELETE CASCADE
) STRICT;`;
export const LEGACY_PARTICIPANT_OPTIONAL_COLUMNS = [
  "session_participants.actor_source",
  "session_participants.contribution_count",
];

export function sessionParticipantsSchemaSql(): string {
  return extractSqliteTableSchema(OPENCLAW_AGENT_SCHEMA_SQL, SESSION_PARTICIPANTS_TABLE, {
    endMarker: "CREATE TABLE IF NOT EXISTS session_key_contract (",
    includeEndMarker: false,
    errorMessage: "OpenClaw session participant schema markers are missing.",
  });
}

/** Historical structural/media validation must not require a future identity key. */
function withLegacySessionParticipantsSchema(sql: string): string {
  return withoutCanonicalSessionValidationSchema(sql).replace(
    sessionParticipantsSchemaSql().trim(),
    LEGACY_PARTICIPANTS_SCHEMA,
  );
}

export const RETIRED_AGENT_STATE_LEASE_SCHEMA_SQL = `
CREATE TABLE state_leases (
  scope TEXT NOT NULL,
  lease_key TEXT NOT NULL,
  owner TEXT NOT NULL,
  expires_at INTEGER,
  heartbeat_at INTEGER,
  payload_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (scope, lease_key)
) STRICT;
`;

/** Historical admission and migration witnesses retain the pre-sequence contract. */
export function withoutOutboxEnqueueSequence(schema: string): string {
  return schema.replace(
    "  enqueue_sequence INTEGER PRIMARY KEY,\n  advancement_key TEXT NOT NULL UNIQUE,",
    "  advancement_key TEXT NOT NULL PRIMARY KEY,",
  );
}

const LEGACY_PARENT_INDEX = `CREATE INDEX IF NOT EXISTS idx_agent_transcript_event_parent
  ON transcript_event_identities(session_id, parent_id)
  WHERE parent_id IS NOT NULL;

`;

/** Historical admission must compare the indexes installed by that release. */
function withLegacyAgentWriteLayout(schema: string): string {
  return schema
    .replace(
      /(CREATE TABLE IF NOT EXISTS memory_entry_origins \([\s\S]*?\n\) STRICT), WITHOUT ROWID;/u,
      "$1;",
    )
    .replace(
      "ON session_windows(primary_conversation_id)",
      "ON session_windows(primary_conversation_id, updated_at DESC, session_id)",
    )
    .replace(
      "CREATE INDEX IF NOT EXISTS idx_agent_transcript_event_sequence",
      `${LEGACY_PARENT_INDEX}CREATE INDEX IF NOT EXISTS idx_agent_transcript_event_sequence`,
    );
}

// Same-version schema-39 additions must not rewrite earlier admission contracts.
const AGENT_SCHEMA_BEFORE_SESSION_DELETION_INDEXES = OPENCLAW_AGENT_SCHEMA_SQL.replace(
  /\nCREATE INDEX IF NOT EXISTS idx_agent_(?:session_input_completions_session_key|conversation_deliveries_source_session)\b[^;]*;\n/gu,
  "",
);

/** Compare historical migration targets against only the representation they support. */
export function getOpenClawAgentMigrationSchema(targetVersion: number): string {
  const schemaSql =
    targetVersion < 39 ? AGENT_SCHEMA_BEFORE_SESSION_DELETION_INDEXES : OPENCLAW_AGENT_SCHEMA_SQL;
  const navigationSchemaSql =
    targetVersion < AGENT_COLD_NAVIGATION_SCHEMA_VERSION
      ? withoutAgentColdNavigation(schemaSql)
      : schemaSql;
  const coldArchiveSchemaSql =
    targetVersion < AGENT_COLD_ARCHIVE_CHUNKS_SCHEMA_VERSION
      ? withoutAgentColdArchiveChunks(navigationSchemaSql)
      : navigationSchemaSql;
  const revisionSchemaSql =
    targetVersion < AGENT_MEMORY_REVISION_SCHEMA_VERSION
      ? withLegacyAgentMemoryRevisionTriggers(coldArchiveSchemaSql)
      : coldArchiveSchemaSql;
  const trajectorySchemaSql =
    targetVersion < AGENT_TRAJECTORY_STORAGE_SCHEMA_VERSION
      ? withoutTrajectoryPayloadColumns(revisionSchemaSql)
      : revisionSchemaSql;
  const indexSchemaSql =
    targetVersion < AGENT_INDEX_RETIREMENT_SCHEMA_VERSION
      ? withLegacyAgentIndexes(trajectorySchemaSql)
      : trajectorySchemaSql;
  const layoutSchemaSql =
    targetVersion < AGENT_WRITE_LAYOUT_SCHEMA_VERSION
      ? withLegacyAgentWriteLayout(indexSchemaSql)
      : indexSchemaSql;
  const sequenceSchemaSql =
    targetVersion < AGENT_OUTBOX_SEQUENCE_SCHEMA_VERSION
      ? withoutOutboxEnqueueSequence(layoutSchemaSql)
      : layoutSchemaSql;
  const predicateSchemaSql =
    targetVersion < AGENT_JSON_PREDICATE_SCHEMA_VERSION
      ? withoutAgentJsonPredicateColumns(sequenceSchemaSql)
      : sequenceSchemaSql;
  const canonicalSchemaSql =
    targetVersion < CANONICAL_SESSION_WRITER_VALIDATION_SCHEMA_VERSION
      ? withLegacyCanonicalSessionValidationTriggers(predicateSchemaSql)
      : predicateSchemaSql;
  const sessionSchemaSql =
    targetVersion < SESSION_ENTRY_SNAPSHOTS_SCHEMA_VERSION
      ? withoutSessionEntrySnapshotsSchema(canonicalSchemaSql)
      : canonicalSchemaSql;
  const targetSchemaSql =
    targetVersion < AGENT_STORAGE_SCHEMA_VERSION
      ? withLegacyAgentStorageSchema(sessionSchemaSql, targetVersion)
      : sessionSchemaSql;
  return targetVersion < 18
    ? withLegacySessionParticipantsSchema(targetSchemaSql)
    : targetVersion < CANONICAL_SESSION_VALIDATION_SCHEMA_VERSION
      ? withoutCanonicalSessionValidationSchema(targetSchemaSql)
      : targetSchemaSql;
}

export const OPENCLAW_AGENT_BOARD_SCHEMA_SQL = extractSqliteTableSchema(
  OPENCLAW_AGENT_SCHEMA_SQL,
  "board_tabs",
  {
    endMarker: "CREATE TABLE IF NOT EXISTS session_progress_cards (",
    includeEndMarker: false,
    errorMessage: "OpenClaw agent board schema markers are missing from the canonical schema.",
  },
);
export const AGENT_V14_BOARD_SCHEMA_SQL = OPENCLAW_AGENT_BOARD_SCHEMA_SQL;
const OPENCLAW_AGENT_SCHEMA_WITHOUT_BOARD_SQL = withLegacyAgentIndexes(
  withoutTrajectoryPayloadColumns(
    withLegacyAgentMemoryRevisionTriggers(
      withoutAgentColdArchiveChunks(AGENT_SCHEMA_BEFORE_SESSION_DELETION_INDEXES),
    ),
  ),
).replace(OPENCLAW_AGENT_BOARD_SCHEMA_SQL, "");

export const SESSION_PROGRESS_CARDS_TABLE = "session_progress_cards";
export const AGENT_PROGRESS_CARD_SCHEMA_SQL = extractSqliteTableSchema(
  OPENCLAW_AGENT_SCHEMA_WITHOUT_BOARD_SQL,
  SESSION_PROGRESS_CARDS_TABLE,
  {
    endMarker: "CREATE TABLE IF NOT EXISTS heartbeat_outcomes (",
    includeEndMarker: false,
    errorMessage: "OpenClaw agent progress-card schema markers are missing.",
  },
);
const AGENT_SCHEMA_WITHOUT_PROGRESS_CARD_SQL = OPENCLAW_AGENT_SCHEMA_WITHOUT_BOARD_SQL.replace(
  AGENT_PROGRESS_CARD_SCHEMA_SQL,
  "",
);

const SUGGESTIONS_SCHEMA_START = "CREATE TABLE IF NOT EXISTS session_suggestions (";

const sessionSharingSchema = extractSqliteTableSchema(
  AGENT_SCHEMA_WITHOUT_PROGRESS_CARD_SQL,
  "session_members",
  {
    endMarker: "CREATE TABLE IF NOT EXISTS heartbeat_outcomes (",
    includeEndMarker: false,
    errorMessage: "OpenClaw agent session-sharing schema markers are missing.",
  },
);
const sessionSuggestionsStart = sessionSharingSchema.indexOf(SUGGESTIONS_SCHEMA_START);
if (sessionSuggestionsStart === -1) {
  throw new Error("OpenClaw agent session-suggestions schema marker is missing.");
}
export const AGENT_V14_SESSION_SHARING_SCHEMA_SQL = sessionSharingSchema.slice(
  0,
  sessionSuggestionsStart,
);
export const AGENT_V14_ADDITIVE_SCHEMA_SQL = sessionSharingSchema.slice(sessionSuggestionsStart);
export const AGENT_V14_CORE_SCHEMA_SQL = withLegacySessionParticipantsSchema(
  withLegacyAgentStorageSchema(
    withLegacyCanonicalSessionValidationTriggers(
      withoutAgentJsonPredicateColumns(
        withoutOutboxEnqueueSequence(
          withLegacyAgentWriteLayout(
            AGENT_SCHEMA_WITHOUT_PROGRESS_CARD_SQL.replace(sessionSharingSchema, ""),
          ),
        ),
      ),
    ),
  ),
);
