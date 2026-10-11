import type { DatabaseSync } from "node:sqlite";
import { ensureColumn, tableExists } from "./openclaw-state-db-schema-helpers.js";

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

const COLUMN_DECLARATIONS = {
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
export function withoutAgentJsonPredicateColumns(schema: string): string {
  for (const [column, declaration] of Object.entries(COLUMN_DECLARATIONS)) {
    schema = schema.replace(`  ${column} ${declaration},\n`, "");
  }
  return schema;
}

/** Runs once inside the versioned migration transaction, never on runtime reads. */
export function migrateAgentJsonPredicatesInTransaction(database: DatabaseSync): void {
  ensureColumn(database, "session_nodes", "session_started_at INTEGER");
  ensureColumn(database, "session_nodes", "has_optional_references INTEGER NOT NULL DEFAULT 0");
  database.exec(`
    UPDATE session_nodes SET
      session_started_at = CASE WHEN json_valid(entry_json)
        THEN CAST(json_extract(entry_json, '$.sessionStartedAt') AS INTEGER) END,
      has_optional_references = CASE WHEN NOT json_valid(entry_json) OR instr(entry_json, char(0)) > 0 THEN 1
        WHEN json_type(entry_json, '$.previousSessionId') IS NOT NULL
          OR json_type(entry_json, '$.usageFamilySessionIds') IS NOT NULL
          OR json_type(entry_json, '$.compactionCheckpoints') IS NOT NULL THEN 1
        ELSE 0 END;
  `);
  // The outbox is optional until first use; migration must not initialize unused owners.
  if (tableExists(database, "context_engine_turn_outbox")) {
    ensureColumn(database, "context_engine_turn_outbox", "payload_state TEXT");
    database.exec(`
      UPDATE context_engine_turn_outbox SET payload_state = CASE
        WHEN json_valid(payload_json) THEN CASE
          WHEN json_type(payload_json, '$.state') = 'text'
          THEN json_extract(payload_json, '$.state') END END;
    `);
  }
  for (const column of AGENT_JSON_PREDICATE_COLUMNS.transcript_events) {
    ensureColumn(database, "transcript_events", `${column} ${COLUMN_DECLARATIONS[column]}`);
  }
  database.exec(`
    WITH source AS (
      SELECT session_id, seq, CASE WHEN event_json IS NOT NULL THEN event_json
        ELSE json_extract(navigation_json, '$.navigation') END AS event
      FROM transcript_events
    ), navigation AS (
      SELECT session_id, seq, coalesce(json_valid(event), 0) AS valid,
        CASE WHEN json_valid(event) THEN event ELSE '{}' END AS event
      FROM source
    ), fields AS (
      SELECT session_id, seq, valid,
        json_extract(event, '$.type') AS first_type,
        json_extract(event, '$.customType') AS first_custom_type,
        CASE WHEN json_type(event, '$.display') = 'true' THEN 1 ELSE 0 END AS display,
        json_extract(event, '$.message.role') AS role,
        (SELECT value FROM json_each(event) WHERE key = 'type' ORDER BY id DESC LIMIT 1) AS last_type,
        (SELECT value FROM json_each(event) WHERE key = 'customType' ORDER BY id DESC LIMIT 1) AS last_custom_type
      FROM navigation
    )
    UPDATE transcript_events SET
      navigation_type = CASE WHEN fields.first_type IN ('session', 'message', 'reset', 'compaction', 'custom_message', 'custom') THEN fields.first_type END,
      navigation_custom_type = CASE WHEN fields.first_custom_type IN ('openclaw.runtime-context', 'openclaw.cache-ttl') THEN fields.first_custom_type END,
      navigation_display = fields.display,
      message_role = CASE WHEN fields.role IN ('user', 'assistant', 'toolResult', 'system') THEN fields.role END,
      navigation_last_type = CASE WHEN fields.last_type IN ('session', 'message', 'reset', 'compaction', 'custom_message', 'custom') THEN fields.last_type END,
      navigation_last_custom_type = CASE WHEN fields.last_custom_type IN ('openclaw.runtime-context', 'openclaw.cache-ttl') THEN fields.last_custom_type END,
      navigation_valid = fields.valid
    FROM fields WHERE transcript_events.session_id = fields.session_id AND transcript_events.seq = fields.seq;
  `);
}
