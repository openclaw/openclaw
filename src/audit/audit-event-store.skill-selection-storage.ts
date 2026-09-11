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

const SKILL_SELECTION_AUDIT_MAX_ROWS = 100_000;
const SKILL_SELECTION_AUDIT_PRUNE_BATCH_ROWS = 1_024;

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
    CREATE INDEX IF NOT EXISTS idx_audit_skill_selection_events_occurred_sequence
      ON audit_skill_selection_events(occurred_at, sequence);
  `);
}

function countSkillSelectionAuditEvents(db: DatabaseSync): number {
  const row = db.prepare("SELECT COUNT(*) AS count FROM audit_skill_selection_events").get() as
    | { count?: unknown }
    | undefined;
  if (typeof row?.count === "number") {
    return row.count;
  }
  if (typeof row?.count === "bigint" && row.count <= BigInt(Number.MAX_SAFE_INTEGER)) {
    return Number(row.count);
  }
  return 0;
}

function deleteExpiredSkillSelectionAuditEvents(db: DatabaseSync, retainedAfter: number): number {
  ensureSkillSelectionAuditSchema(db);
  const result = db
    .prepare(
      `DELETE FROM audit_skill_selection_events
        WHERE sequence IN (
          SELECT sequence FROM audit_skill_selection_events
          WHERE occurred_at < ?
          ORDER BY occurred_at ASC, sequence ASC
          LIMIT ?
        )`,
    )
    .run(retainedAfter, SKILL_SELECTION_AUDIT_PRUNE_BATCH_ROWS);
  return Number(result.changes ?? 0);
}

function pruneSkillSelectionAuditEventsAfterInsert(db: DatabaseSync, retainedAfter: number): void {
  deleteExpiredSkillSelectionAuditEvents(db, retainedAfter);
  const rowCount = countSkillSelectionAuditEvents(db);
  if (rowCount <= SKILL_SELECTION_AUDIT_MAX_ROWS) {
    return;
  }
  const retainedRows = Math.max(
    0,
    SKILL_SELECTION_AUDIT_MAX_ROWS - SKILL_SELECTION_AUDIT_PRUNE_BATCH_ROWS,
  );
  const cutoff = db
    .prepare(
      `SELECT sequence FROM audit_skill_selection_events
        ORDER BY sequence DESC
        LIMIT 1 OFFSET ?`,
    )
    .get(retainedRows) as { sequence?: unknown } | undefined;
  const sequenceCutoff =
    typeof cutoff?.sequence === "number"
      ? cutoff.sequence
      : typeof cutoff?.sequence === "bigint" && cutoff.sequence <= BigInt(Number.MAX_SAFE_INTEGER)
        ? Number(cutoff.sequence)
        : undefined;
  if (sequenceCutoff === undefined) {
    return;
  }
  db.prepare("DELETE FROM audit_skill_selection_events WHERE sequence <= ?").run(sequenceCutoff);
}

function normalizeSequenceHighWater(value: unknown): number {
  if (value === null || value === undefined) {
    return 0;
  }
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return value;
  }
  if (typeof value === "bigint" && value <= BigInt(Number.MAX_SAFE_INTEGER)) {
    return Number(value);
  }
  if (typeof value === "string" && /^\d+(?:\.0+)?$/u.test(value)) {
    const sequence = BigInt(value.split(".")[0] ?? "0");
    if (sequence > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error("audit event sequence high-water mark exceeds the supported integer range");
    }
    return Number(sequence);
  }
  throw new Error("audit event sequence high-water mark is invalid");
}

function readAuditSequenceHighWater(db: DatabaseSync): number {
  const sequenceRow = db
    .prepare("SELECT CAST(seq AS TEXT) AS seq FROM sqlite_sequence WHERE name = 'audit_events'")
    .get() as { seq?: unknown } | undefined;
  const auditRow = db.prepare("SELECT MAX(sequence) AS sequence FROM audit_events").get() as
    | { sequence?: unknown }
    | undefined;
  const skillRow = tableExists(db, "audit_skill_selection_events")
    ? (db.prepare("SELECT MAX(sequence) AS sequence FROM audit_skill_selection_events").get() as
        | { sequence?: unknown }
        | undefined)
    : undefined;
  return Math.max(
    normalizeSequenceHighWater(sequenceRow?.seq),
    normalizeSequenceHighWater(auditRow?.sequence),
    normalizeSequenceHighWater(skillRow?.sequence),
  );
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
  pruneSkillSelectionAuditEventsAfterInsert(db, retainedAfter);
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

export function pruneExpiredSkillSelectionAuditEvents(params: {
  db: DatabaseSync;
  retainedAfter: number;
}): number {
  return deleteExpiredSkillSelectionAuditEvents(params.db, params.retainedAfter);
}
