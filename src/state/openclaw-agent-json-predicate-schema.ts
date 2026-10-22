import type { DatabaseSync } from "node:sqlite";
import {
  AGENT_JSON_PREDICATE_COLUMNS,
  AGENT_JSON_PREDICATE_COLUMN_DECLARATIONS as COLUMN_DECLARATIONS,
} from "./openclaw-agent-schema-history.js";
import { ensureColumn, tableExists } from "./openclaw-state-db-schema-helpers.js";

export { AGENT_JSON_PREDICATE_COLUMNS } from "./openclaw-agent-schema-history.js";

/** Runs once inside the versioned migration transaction, never on runtime reads. */
export function migrateAgentJsonPredicatesInTransaction(database: DatabaseSync): void {
  ensureColumn(database, "session_nodes", "session_started_at INTEGER");
  ensureColumn(database, "session_nodes", "has_optional_references INTEGER NOT NULL DEFAULT 0");
  // sqlite-allow-raw: versioned backfill preserves legacy SQLite coercion before schema publication.
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
    // sqlite-allow-raw: one-time backfill of an existing optional table inside the schema transaction.
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
  // Old transcript rows stay byte-for-byte intact. Reads derive missing predicates
  // within their existing windows; ordinary payload writes publish all fields.
}
