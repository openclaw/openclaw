import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import { parseSkillSelectionAuditRow } from "./audit-event-store.skill-selection.js";
import {
  AUDIT_EVENT_SCHEMA_VERSION,
  type AuditEventInput,
  type AuditEventListFilters,
  type AuditEventRecord,
} from "./audit-event-types.js";

type SkillSelectionAuditRow = {
  sequence: number | bigint;
  event_id: string;
  source_id: string;
  schema_version: number | bigint;
  source_sequence: number | bigint;
  occurred_at: number | bigint;
  tool_name: string | null;
  action: string | null;
  status: string | null;
  actor_type: string | null;
  actor_id: string | null;
  agent_id: string | null;
  session_key: string | null;
  session_id: string | null;
  run_id: string | null;
};

function ensureSkillSelectionAuditSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS audit_skill_selection_events (
      sequence INTEGER PRIMARY KEY,
      event_id TEXT NOT NULL UNIQUE,
      source_id TEXT NOT NULL UNIQUE,
      schema_version INTEGER NOT NULL DEFAULT 1,
      source_sequence INTEGER NOT NULL,
      occurred_at INTEGER NOT NULL,
      action TEXT NOT NULL,
      status TEXT NOT NULL,
      actor_type TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      session_key TEXT,
      session_id TEXT,
      run_id TEXT NOT NULL,
      tool_name TEXT NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS idx_audit_skill_selection_events_agent_sequence
      ON audit_skill_selection_events(agent_id, sequence DESC);
    CREATE INDEX IF NOT EXISTS idx_audit_skill_selection_events_session_sequence
      ON audit_skill_selection_events(session_key, sequence DESC);
    CREATE INDEX IF NOT EXISTS idx_audit_skill_selection_events_run_sequence
      ON audit_skill_selection_events(run_id, sequence DESC);
    CREATE INDEX IF NOT EXISTS idx_audit_skill_selection_events_status_sequence
      ON audit_skill_selection_events(status, sequence DESC);
  `);
}

function readAuditSequenceHighWater(db: DatabaseSync): number {
  const row = db
    .prepare("SELECT CAST(seq AS TEXT) AS seq FROM sqlite_sequence WHERE name = 'audit_events'")
    .get() as { seq?: unknown } | undefined;
  if (row === undefined) {
    return 0;
  }
  if (typeof row.seq !== "string" || !/^\d+$/u.test(row.seq)) {
    throw new Error("audit event sequence high-water mark is invalid");
  }
  const sequence = BigInt(row.seq);
  if (sequence > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("audit event sequence high-water mark exceeds the supported integer range");
  }
  return Number(sequence);
}

function allocateAuditSequence(db: DatabaseSync): number {
  const nextSequence = readAuditSequenceHighWater(db) + 1;
  if (!Number.isSafeInteger(nextSequence) || nextSequence < 1) {
    throw new Error("audit event sequence is outside the supported integer range");
  }
  const updated = db
    .prepare("UPDATE sqlite_sequence SET seq = ? WHERE name = 'audit_events'")
    .run(nextSequence);
  if (Number(updated.changes ?? 0) === 0) {
    db.prepare("INSERT INTO sqlite_sequence(name, seq) VALUES ('audit_events', ?)").run(
      nextSequence,
    );
  }
  return nextSequence;
}

function bindSkillSelectionAuditEvent(
  sequence: number,
  input: Extract<AuditEventInput, { kind: "skill_selection" }>,
): SkillSelectionAuditRow {
  return {
    sequence,
    event_id: randomUUID(),
    source_id: input.sourceId,
    source_sequence: input.sourceSequence,
    schema_version: AUDIT_EVENT_SCHEMA_VERSION,
    occurred_at: input.occurredAt,
    action: input.action,
    status: input.status,
    actor_type: input.actorType,
    actor_id: input.actorId,
    agent_id: input.agentId,
    session_key: input.sessionKey ?? null,
    session_id: input.sessionId ?? null,
    run_id: input.runId,
    tool_name: input.toolName ?? "unknown",
  };
}

export function recordSkillSelectionAuditEvent(
  input: Extract<AuditEventInput, { kind: "skill_selection" }>,
  db: DatabaseSync,
  retainedAfter: number,
): AuditEventRecord | undefined {
  ensureSkillSelectionAuditSchema(db);
  const sequence = allocateAuditSequence(db);
  const row = bindSkillSelectionAuditEvent(sequence, input);
  const result = db
    .prepare(
      `INSERT OR IGNORE INTO audit_skill_selection_events (
        sequence, event_id, source_id, schema_version, source_sequence, occurred_at,
        action, status, actor_type, actor_id, agent_id, session_key, session_id, run_id, tool_name
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      row.sequence,
      row.event_id,
      row.source_id,
      row.schema_version,
      row.source_sequence,
      row.occurred_at,
      row.action,
      row.status,
      row.actor_type,
      row.actor_id,
      row.agent_id,
      row.session_key,
      row.session_id,
      row.run_id,
      row.tool_name,
    );
  if (Number(result.changes ?? 0) === 0) {
    return undefined;
  }
  db.prepare(
    `DELETE FROM audit_skill_selection_events
      WHERE occurred_at < ?`,
  ).run(retainedAfter);
  const inserted = db
    .prepare("SELECT * FROM audit_skill_selection_events WHERE sequence = ?")
    .get(sequence) as SkillSelectionAuditRow | undefined;
  return inserted ? parseSkillSelectionAuditRow(inserted) : undefined;
}

export function listSkillSelectionAuditEvents(params: {
  db: DatabaseSync;
  filters: AuditEventListFilters;
  retainedAfter: number;
  cursor?: number;
  limit: number;
}): AuditEventRecord[] {
  if (!tableExists(params.db, "audit_skill_selection_events")) {
    return [];
  }
  if (
    (params.filters.kind !== undefined && params.filters.kind !== "skill_selection") ||
    params.filters.direction !== undefined ||
    params.filters.channel !== undefined
  ) {
    return [];
  }
  const clauses = ["occurred_at >= ?"];
  const values: Array<string | number> = [params.retainedAfter];
  if (params.cursor !== undefined) {
    clauses.push("sequence < ?");
    values.push(params.cursor);
  }
  if (params.filters.agentId) {
    clauses.push("agent_id = ?");
    values.push(params.filters.agentId);
  }
  if (params.filters.sessionKey) {
    clauses.push("session_key = ?");
    values.push(params.filters.sessionKey);
  }
  if (params.filters.runId) {
    clauses.push("run_id = ?");
    values.push(params.filters.runId);
  }
  if (params.filters.status) {
    clauses.push("status = ?");
    values.push(params.filters.status);
  }
  if (params.filters.after !== undefined) {
    clauses.push("occurred_at >= ?");
    values.push(params.filters.after);
  }
  if (params.filters.before !== undefined) {
    clauses.push("occurred_at <= ?");
    values.push(params.filters.before);
  }
  const rows = params.db
    .prepare(
      `SELECT * FROM audit_skill_selection_events
        WHERE ${clauses.join(" AND ")}
        ORDER BY sequence DESC
        LIMIT ?`,
    )
    .all(...values, params.limit) as SkillSelectionAuditRow[];
  return rows.map(parseSkillSelectionAuditRow);
}
