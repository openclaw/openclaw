import type { DatabaseSync } from "node:sqlite";
import { tableExists } from "./openclaw-state-db-schema-helpers.js";
import {
  AUDIT_EVENT_MIGRATED_COLUMNS,
  canRepairLegacyAuditEventsSchema,
  hasCanonicalAuditEventsSchema,
} from "./openclaw-state-schema-inspection.js";

function readAuditEventSequenceHighWater(db: DatabaseSync): number | undefined {
  if (!tableExists(db, "sqlite_sequence")) {
    return undefined;
  }
  const row = db
    .prepare("SELECT CAST(seq AS TEXT) AS seq FROM sqlite_sequence WHERE name = 'audit_events'")
    .get();
  if (row === undefined) {
    return undefined;
  }
  if (typeof row.seq !== "string" || !/^\d+$/.test(row.seq)) {
    throw new Error("audit event sequence high-water mark is invalid");
  }
  const sequence = BigInt(row.seq);
  if (sequence > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("audit event sequence high-water mark exceeds the supported integer range");
  }
  return Number(sequence);
}

function restoreAuditEventSequenceHighWater(db: DatabaseSync, sequence: number | undefined): void {
  if (sequence === undefined) {
    return;
  }
  db.prepare("DELETE FROM sqlite_sequence WHERE name = 'audit_events'").run();
  db.prepare("INSERT INTO sqlite_sequence (name, seq) VALUES ('audit_events', ?)").run(sequence);
}

export function repairAuditEventsSchema(db: DatabaseSync): boolean {
  if (hasCanonicalAuditEventsSchema(db) || !canRepairLegacyAuditEventsSchema(db)) {
    return false;
  }
  const sequenceHighWater = readAuditEventSequenceHighWater(db);
  // This is the only shipped legacy shape. The surrounding doctor transaction
  // rolls back the table swap and sequence restore together on any bad row.
  // canRepairLegacyAuditEventsSchema refuses foreign audit_events_migration_new
  // tables, so this CREATE never clobbers existing data.
  db.exec(`
    CREATE TABLE audit_events_migration_new (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL UNIQUE,
      source_id TEXT NOT NULL UNIQUE,
      schema_version INTEGER NOT NULL DEFAULT 1,
      source_sequence INTEGER NOT NULL,
      occurred_at INTEGER NOT NULL,
      kind TEXT NOT NULL,
      action TEXT NOT NULL,
      status TEXT NOT NULL,
      error_code TEXT,
      actor_type TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      agent_id TEXT,
      session_key TEXT,
      session_id TEXT,
      run_id TEXT,
      tool_call_id TEXT,
      tool_name TEXT,
      direction TEXT,
      channel TEXT,
      conversation_kind TEXT,
      message_outcome TEXT,
      reason_code TEXT,
      delivery_kind TEXT,
      failure_stage TEXT,
      duration_ms INTEGER,
      result_count INTEGER,
      account_ref TEXT,
      conversation_ref TEXT,
      message_ref TEXT,
      target_ref TEXT
    );
    INSERT INTO audit_events_migration_new (${AUDIT_EVENT_MIGRATED_COLUMNS.join(", ")})
    SELECT ${AUDIT_EVENT_MIGRATED_COLUMNS.map((column) => (column === "schema_version" ? "1" : column)).join(", ")}
    FROM audit_events;
    DROP TABLE audit_events;
    ALTER TABLE audit_events_migration_new RENAME TO audit_events;
    CREATE INDEX idx_audit_events_time
      ON audit_events(occurred_at DESC, sequence DESC);
    CREATE INDEX idx_audit_events_agent_sequence
      ON audit_events(agent_id, sequence DESC);
    CREATE INDEX idx_audit_events_session_sequence
      ON audit_events(session_key, sequence DESC);
    CREATE INDEX idx_audit_events_run_sequence
      ON audit_events(run_id, sequence DESC);
    CREATE INDEX idx_audit_events_kind_sequence
      ON audit_events(kind, sequence DESC);
    CREATE INDEX idx_audit_events_status_sequence
      ON audit_events(status, sequence DESC);
    CREATE INDEX idx_audit_events_channel_sequence
      ON audit_events(channel, sequence DESC);
    CREATE INDEX idx_audit_events_direction_sequence
      ON audit_events(direction, sequence DESC);
    CREATE TABLE IF NOT EXISTS audit_identity_keys (
      id INTEGER NOT NULL PRIMARY KEY CHECK (id = 1),
      key_id TEXT NOT NULL,
      key BLOB NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);
  // AUTOINCREMENT is part of the stable cursor contract. Rebuilding an empty
  // or sparsely retained table must not reuse a sequence already handed out.
  restoreAuditEventSequenceHighWater(db, sequenceHighWater);
  return true;
}
