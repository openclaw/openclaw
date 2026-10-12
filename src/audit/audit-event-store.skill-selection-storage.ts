import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { ColumnType, Insertable } from "kysely";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { normalizeSqliteNumber } from "../infra/sqlite-number.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import { parseSkillSelectionAuditRow } from "./audit-event-store.skill-selection.js";
import {
  AUDIT_EVENT_SCHEMA_VERSION,
  type AuditEventInput,
  type AuditEventListFilters,
  type AuditEventRecord,
} from "./audit-event-types.js";

const SKILL_SELECTION_AUDIT_MAX_ROWS = 100_000;
const SKILL_SELECTION_AUDIT_PRUNE_BATCH_ROWS = 1_024;

type SkillSelectionAuditTable = OpenClawStateKyselyDatabase["audit_skill_selection_events"];
type SqliteSequenceTable = {
  name: string;
  seq: ColumnType<unknown, number, number>;
};
type AuditSkillSelectionDatabase = Pick<
  OpenClawStateKyselyDatabase,
  "audit_events" | "audit_skill_selection_events"
> & {
  sqlite_sequence: SqliteSequenceTable;
};

function getSkillSelectionAuditKysely(db: DatabaseSync) {
  return getNodeSqliteKysely<AuditSkillSelectionDatabase>(db);
}

/**
 * Per-connection skill-selection row-count cache, mirroring the
 * `auditEventRowCounts` pattern of the canonical ledger: ordinary writes
 * do bounded work and only fall back to COUNT(*) on a cold cache.
 */
const skillSelectionAuditRowCounts = new Map<DatabaseSync, number>();

/**
 * Connections whose companion schema is established. The canonical schema
 * admission owns this table (see openclaw-state-schema.sql); additive DDL
 * below only runs for databases created before admission, at most once
 * per connection.
 */
const skillSelectionSchemaEstablished = new WeakSet<DatabaseSync>();

/** Drops cached skill-selection facts for a connection (rollback path). */
export function invalidateSkillSelectionAuditCachesForDatabase(db: DatabaseSync): void {
  skillSelectionAuditRowCounts.delete(db);
  skillSelectionSchemaEstablished.delete(db);
}

function ensureSkillSelectionAuditSchema(db: DatabaseSync): void {
  // sqlite-allow-raw -- Canonical additive DDL only; skill-selection rows use Kysely.
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
  const row = executeSqliteQueryTakeFirstSync(
    db,
    getSkillSelectionAuditKysely(db)
      .selectFrom("audit_skill_selection_events")
      .select((expression) => expression.fn.countAll<number>().as("count")),
  );
  return normalizeSqliteNumber(row?.count ?? null) ?? 0;
}

function ensureSkillSelectionAuditSchemaOnce(db: DatabaseSync): void {
  if (skillSelectionSchemaEstablished.has(db)) {
    return;
  }
  if (!tableExists(db, "audit_skill_selection_events")) {
    ensureSkillSelectionAuditSchema(db);
  }
  skillSelectionSchemaEstablished.add(db);
}

function deleteExpiredSkillSelectionAuditEvents(db: DatabaseSync, retainedAfter: number): number {
  ensureSkillSelectionAuditSchemaOnce(db);
  const kysely = getSkillSelectionAuditKysely(db);
  const expiredSequences = kysely
    .selectFrom("audit_skill_selection_events")
    .select("sequence")
    .where("occurred_at", "<", retainedAfter)
    .orderBy("occurred_at", "asc")
    .orderBy("sequence", "asc")
    .limit(SKILL_SELECTION_AUDIT_PRUNE_BATCH_ROWS);
  const result = executeSqliteQuerySync(
    db,
    kysely.deleteFrom("audit_skill_selection_events").where("sequence", "in", expiredSequences),
  );
  // Single-owner accounting: this deleter never touches the warm count.
  // Each caller (insert prune, maintenance tick) adjusts the cache from
  // the returned count exactly once.
  return Number(result.numAffectedRows ?? 0n);
}

function pruneSkillSelectionAuditEventsAfterInsert(db: DatabaseSync, retainedAfter: number): void {
  const expiredCount = deleteExpiredSkillSelectionAuditEvents(db, retainedAfter);
  // One COUNT(*) per connection lifetime: a warm cache advances by
  // (+1 insert, −expired) exactly like the canonical ledger pattern.
  const cachedCount = skillSelectionAuditRowCounts.get(db);
  const rowCount =
    cachedCount === undefined
      ? countSkillSelectionAuditEvents(db)
      : Math.max(0, cachedCount + 1 - expiredCount);
  if (rowCount <= SKILL_SELECTION_AUDIT_MAX_ROWS) {
    skillSelectionAuditRowCounts.set(db, rowCount);
    return;
  }
  const retainedRows = Math.max(
    0,
    SKILL_SELECTION_AUDIT_MAX_ROWS - SKILL_SELECTION_AUDIT_PRUNE_BATCH_ROWS,
  );
  const kysely = getSkillSelectionAuditKysely(db);
  const cutoff = executeSqliteQueryTakeFirstSync(
    db,
    kysely
      .selectFrom("audit_skill_selection_events")
      .select("sequence")
      .orderBy("sequence", "desc")
      .offset(retainedRows)
      .limit(1),
  );
  const sequenceCutoff = cutoff ? normalizeSqliteNumber(cutoff.sequence) : undefined;
  if (sequenceCutoff === undefined) {
    return;
  }
  const pruned = executeSqliteQuerySync(
    db,
    kysely.deleteFrom("audit_skill_selection_events").where("sequence", "<=", sequenceCutoff),
  );
  skillSelectionAuditRowCounts.set(
    db,
    Math.max(0, rowCount - Number(pruned.numAffectedRows ?? 0n)),
  );
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
  const kysely = getSkillSelectionAuditKysely(db);
  const sequenceRow = executeSqliteQueryTakeFirstSync(
    db,
    kysely.selectFrom("sqlite_sequence").select("seq").where("name", "=", "audit_events"),
  );
  const auditRow = executeSqliteQueryTakeFirstSync(
    db,
    kysely.selectFrom("audit_events").select((eb) => eb.fn.max("sequence").as("sequence")),
  );
  const skillRow = tableExists(db, "audit_skill_selection_events")
    ? executeSqliteQueryTakeFirstSync(
        db,
        kysely
          .selectFrom("audit_skill_selection_events")
          .select((eb) => eb.fn.max("sequence").as("sequence")),
      )
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
  const kysely = getSkillSelectionAuditKysely(db);
  const updated = executeSqliteQuerySync(
    db,
    kysely
      .updateTable("sqlite_sequence")
      .set({ seq: nextSequence })
      .where("name", "=", "audit_events"),
  );
  if (Number(updated.numAffectedRows ?? 0n) === 0) {
    executeSqliteQuerySync(
      db,
      kysely.insertInto("sqlite_sequence").values({ name: "audit_events", seq: nextSequence }),
    );
  }
  return nextSequence;
}

function bindSkillSelectionAuditEvent(
  sequence: number,
  input: Extract<AuditEventInput, { kind: "skill_selection" }>,
): Insertable<SkillSelectionAuditTable> {
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
  ensureSkillSelectionAuditSchemaOnce(db);
  const sequence = allocateAuditSequence(db);
  const row = bindSkillSelectionAuditEvent(sequence, input);
  const inserted = executeSqliteQueryTakeFirstSync(
    db,
    getSkillSelectionAuditKysely(db)
      .insertInto("audit_skill_selection_events")
      .values(row)
      .onConflict((conflict) => conflict.column("source_id").doNothing())
      .returningAll(),
  );
  if (inserted === undefined) {
    return undefined;
  }
  pruneSkillSelectionAuditEventsAfterInsert(db, retainedAfter);
  return parseSkillSelectionAuditRow(inserted);
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
  let query = getSkillSelectionAuditKysely(params.db)
    .selectFrom("audit_skill_selection_events")
    .selectAll()
    .where("occurred_at", ">=", params.retainedAfter);
  if (params.cursor !== undefined) {
    query = query.where("sequence", "<", params.cursor);
  }
  if (params.filters.agentId) {
    query = query.where("agent_id", "=", params.filters.agentId);
  }
  if (params.filters.sessionKey) {
    query = query.where("session_key", "=", params.filters.sessionKey);
  }
  if (params.filters.runId) {
    query = query.where("run_id", "=", params.filters.runId);
  }
  if (params.filters.status) {
    query = query.where("status", "=", params.filters.status);
  }
  if (params.filters.after !== undefined) {
    query = query.where("occurred_at", ">=", params.filters.after);
  }
  if (params.filters.before !== undefined) {
    query = query.where("occurred_at", "<=", params.filters.before);
  }
  const rows = executeSqliteQuerySync(
    params.db,
    query.orderBy("sequence", "desc").limit(params.limit),
  ).rows;
  return rows.map(parseSkillSelectionAuditRow);
}

export function pruneExpiredSkillSelectionAuditEvents(params: {
  db: DatabaseSync;
  retainedAfter: number;
}): number {
  const deleted = deleteExpiredSkillSelectionAuditEvents(params.db, params.retainedAfter);
  // Maintenance ticks own their accounting: a warm count drops by exactly
  // the rows this tick removed.
  const cachedCount = skillSelectionAuditRowCounts.get(params.db);
  if (cachedCount !== undefined) {
    skillSelectionAuditRowCounts.set(params.db, Math.max(0, cachedCount - deleted));
  }
  return deleted;
}
