import { randomUUID } from "node:crypto";
import type { Insertable } from "kysely";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../../infra/kysely-sync.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../../state/openclaw-agent-db.generated.js";
import {
  listOpenClawRegisteredAgentDatabases,
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
  type OpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import type { OpenClawStateDatabaseOptions } from "../../state/openclaw-state-db.js";

export type SqliteSessionTranscriptEvent = {
  seq: number;
  event: unknown;
  createdAt: number;
};

export type SqliteSessionTranscriptMessageRole =
  | "system"
  | "user"
  | "assistant"
  | "tool"
  | "toolResult"
  | "other";

export type SqliteSessionTranscriptProjectedEvent = SqliteSessionTranscriptEvent & {
  eventType?: string;
  eventId?: string;
  parentId?: string | null;
  messageRole?: SqliteSessionTranscriptMessageRole;
  toolCallIds: string[];
  toolResultIds: string[];
};

export type SqliteSessionTranscriptStoreOptions = OpenClawStateDatabaseOptions & {
  agentId: string;
  sessionId: string;
};

export type AppendSqliteSessionTranscriptEventOptions = SqliteSessionTranscriptStoreOptions & {
  event: unknown;
  now?: () => number;
};

export type AppendSqliteSessionTranscriptMessageOptions = SqliteSessionTranscriptStoreOptions & {
  cwd?: string;
  message: unknown;
  now?: () => number;
  sessionVersion: number;
};

export type ReplaceSqliteSessionTranscriptEventsOptions = SqliteSessionTranscriptStoreOptions & {
  events: unknown[];
  now?: () => number;
};

export type ExportSqliteTranscriptJsonlOptions = SqliteSessionTranscriptStoreOptions;

export type SqliteSessionTranscriptScope = {
  agentId: string;
  sessionId: string;
};

export type SqliteSessionTranscript = SqliteSessionTranscriptScope & {
  updatedAt: number;
  eventCount: number;
};

export type SqliteSessionTranscriptSnapshot = SqliteSessionTranscriptScope & {
  snapshotId: string;
  reason: string;
  eventCount: number;
  createdAt: number;
  metadata: unknown;
};

type TranscriptEventsTable = OpenClawAgentKyselyDatabase["transcript_events"];
type TranscriptEventIdentitiesTable = OpenClawAgentKyselyDatabase["transcript_event_identities"];
type AgentTranscriptDatabase = Pick<
  OpenClawAgentKyselyDatabase,
  "transcript_event_identities" | "transcript_events" | "transcript_snapshots"
>;

function normalizeSessionId(value: string): string {
  const sessionId = value.trim();
  if (!sessionId) {
    throw new Error("SQLite transcript store requires a session id.");
  }
  return sessionId;
}

function normalizeTranscriptScope(options: SqliteSessionTranscriptStoreOptions): {
  agentId: string;
  sessionId: string;
} {
  return {
    agentId: normalizeAgentId(options.agentId),
    sessionId: normalizeSessionId(options.sessionId),
  };
}

function parseTranscriptEventJson(value: unknown, seq: number): unknown {
  if (typeof value !== "string") {
    throw new Error(`SQLite transcript event ${seq} is not stored as JSON.`);
  }
  return JSON.parse(value);
}

function parseCreatedAt(value: unknown): number {
  return typeof value === "bigint" ? Number(value) : Number(value);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readTrimmedString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function readRecordString(record: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = readTrimmedString(record[key]);
    if (value) {
      return value;
    }
  }
  return undefined;
}

function pushUniqueId(ids: string[], value: unknown): void {
  const id = readTrimmedString(value);
  if (id && !ids.includes(id)) {
    ids.push(id);
  }
}

function normalizeProjectedMessageRole(
  role: unknown,
): SqliteSessionTranscriptMessageRole | undefined {
  const normalized = readTrimmedString(role);
  switch (normalized?.toLowerCase()) {
    case "system":
      return "system";
    case "user":
      return "user";
    case "assistant":
      return "assistant";
    case "tool":
      return "tool";
    case "tool_result":
    case "toolresult":
      return "toolResult";
    default:
      return normalized ? "other" : undefined;
  }
}

function collectToolCallIds(value: unknown, ids: string[]): void {
  const items = Array.isArray(value) ? value : value ? [value] : [];
  for (const item of items) {
    const record = asRecord(item);
    if (!record) {
      continue;
    }
    pushUniqueId(
      ids,
      readRecordString(record, "id", "toolCallId", "tool_call_id", "toolUseId", "tool_use_id"),
    );
  }
}

function collectToolIdsFromContent(
  content: unknown,
  toolCallIds: string[],
  toolResultIds: string[],
): void {
  if (!Array.isArray(content)) {
    return;
  }
  const callTypes = new Set([
    "toolcall",
    "tooluse",
    "functioncall",
    "tool_call",
    "tool_use",
    "function_call",
  ]);
  const resultTypes = new Set(["tool", "toolresult", "tool_result"]);
  for (const block of content) {
    const record = asRecord(block);
    if (!record) {
      continue;
    }
    const type = readTrimmedString(record.type)?.toLowerCase();
    if (type && callTypes.has(type)) {
      pushUniqueId(
        toolCallIds,
        readRecordString(record, "id", "toolCallId", "tool_call_id", "toolUseId", "tool_use_id"),
      );
      continue;
    }
    if (type && resultTypes.has(type)) {
      pushUniqueId(
        toolResultIds,
        readRecordString(record, "toolCallId", "tool_call_id", "toolUseId", "tool_use_id", "id"),
      );
    }
  }
}

function collectMessageToolIds(message: Record<string, unknown>): {
  toolCallIds: string[];
  toolResultIds: string[];
} {
  const toolCallIds: string[] = [];
  const toolResultIds: string[] = [];
  collectToolCallIds(message.tool_calls, toolCallIds);
  collectToolCallIds(message.toolCalls, toolCallIds);
  collectToolCallIds(message.function_call, toolCallIds);
  collectToolCallIds(message.functionCall, toolCallIds);
  collectToolIdsFromContent(message.content, toolCallIds, toolResultIds);
  pushUniqueId(
    toolResultIds,
    readRecordString(message, "toolCallId", "tool_call_id", "toolUseId", "tool_use_id"),
  );
  return { toolCallIds, toolResultIds };
}

function getAgentTranscriptKysely(db: import("node:sqlite").DatabaseSync) {
  return getNodeSqliteKysely<AgentTranscriptDatabase>(db);
}

function openTranscriptAgentDatabase(
  options: SqliteSessionTranscriptStoreOptions,
): OpenClawAgentDatabase {
  return openOpenClawAgentDatabase({ env: options.env, agentId: options.agentId });
}

function bindTranscriptEvent(params: {
  sessionId: string;
  seq: number;
  event: unknown;
  createdAt: number;
}): Insertable<TranscriptEventsTable> {
  return {
    session_id: params.sessionId,
    seq: params.seq,
    event_json: JSON.stringify(params.event),
    created_at: params.createdAt,
  };
}

function readMessageIdempotencyKey(message: unknown): string | null {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return null;
  }
  const key = (message as { idempotencyKey?: unknown }).idempotencyKey;
  return typeof key === "string" && key.trim() ? key : null;
}

function readTranscriptEventIdentity(params: {
  sessionId: string;
  seq: number;
  event: unknown;
  createdAt: number;
}): Insertable<TranscriptEventIdentitiesTable> | null {
  if (!params.event || typeof params.event !== "object" || Array.isArray(params.event)) {
    return null;
  }
  const record = params.event as {
    id?: unknown;
    type?: unknown;
    parentId?: unknown;
    message?: { idempotencyKey?: unknown };
  };
  if (typeof record.id !== "string" || !record.id.trim()) {
    return null;
  }
  return {
    session_id: params.sessionId,
    event_id: record.id,
    seq: params.seq,
    event_type: typeof record.type === "string" ? record.type : null,
    has_parent: Object.hasOwn(record, "parentId") ? 1 : 0,
    parent_id: typeof record.parentId === "string" ? record.parentId : null,
    message_idempotency_key: readMessageIdempotencyKey(record.message),
    created_at: params.createdAt,
  };
}

function upsertTranscriptEventIdentity(params: {
  database: OpenClawAgentDatabase;
  sessionId: string;
  seq: number;
  event: unknown;
  createdAt: number;
}): void {
  const identity = readTranscriptEventIdentity(params);
  if (!identity) {
    return;
  }
  executeSqliteQuerySync(
    params.database.db,
    getAgentTranscriptKysely(params.database.db)
      .insertInto("transcript_event_identities")
      .values(identity)
      .onConflict((conflict) =>
        conflict.columns(["session_id", "event_id"]).doUpdateSet({
          seq: (eb) => eb.ref("excluded.seq"),
          event_type: (eb) => eb.ref("excluded.event_type"),
          has_parent: (eb) => eb.ref("excluded.has_parent"),
          parent_id: (eb) => eb.ref("excluded.parent_id"),
          message_idempotency_key: (eb) => eb.ref("excluded.message_idempotency_key"),
          created_at: (eb) => eb.ref("excluded.created_at"),
        }),
      ),
  );
}

function insertTranscriptEvent(params: {
  database: OpenClawAgentDatabase;
  sessionId: string;
  seq: number;
  event: unknown;
  createdAt: number;
}): void {
  executeSqliteQuerySync(
    params.database.db,
    getAgentTranscriptKysely(params.database.db)
      .insertInto("transcript_events")
      .values(
        bindTranscriptEvent({
          sessionId: params.sessionId,
          seq: params.seq,
          event: params.event,
          createdAt: params.createdAt,
        }),
      ),
  );
  upsertTranscriptEventIdentity(params);
}

export function resolveSqliteSessionTranscriptScope(
  options: OpenClawStateDatabaseOptions & {
    agentId?: string;
    sessionId: string;
  },
): SqliteSessionTranscriptScope | undefined {
  const sessionId = normalizeSessionId(options.sessionId);
  if (options.agentId?.trim()) {
    return {
      agentId: normalizeAgentId(options.agentId),
      sessionId,
    };
  }
  return undefined;
}

export function listSqliteSessionTranscripts(
  options: OpenClawStateDatabaseOptions & { agentId?: string } = {},
): SqliteSessionTranscript[] {
  const agentDatabases = options.agentId
    ? [
        {
          agentId: normalizeAgentId(options.agentId),
          path: undefined,
        },
      ]
    : listOpenClawRegisteredAgentDatabases(options);
  const transcripts: SqliteSessionTranscript[] = [];
  for (const agentDatabase of agentDatabases) {
    const database = openOpenClawAgentDatabase({
      ...options,
      agentId: agentDatabase.agentId,
      ...(agentDatabase.path ? { path: agentDatabase.path } : {}),
    });
    transcripts.push(
      ...executeSqliteQuerySync(
        database.db,
        getAgentTranscriptKysely(database.db)
          .selectFrom("transcript_events as events")
          .select([
            "events.session_id",
            (eb) => eb.fn.max<number | bigint>("events.created_at").as("updated_at"),
            (eb) => eb.fn.countAll<number | bigint>().as("event_count"),
          ])
          .groupBy("events.session_id")
          .orderBy("updated_at", "desc")
          .orderBy("events.session_id", "asc"),
      ).rows.flatMap((row) => {
        const record = row;
        if (typeof record.session_id !== "string") {
          return [];
        }
        const updatedAt =
          typeof record.updated_at === "bigint"
            ? Number(record.updated_at)
            : Number(record.updated_at ?? 0);
        const eventCount =
          typeof record.event_count === "bigint"
            ? Number(record.event_count)
            : Number(record.event_count ?? 0);
        return [
          {
            agentId: agentDatabase.agentId,
            sessionId: normalizeSessionId(record.session_id),
            updatedAt: Number.isFinite(updatedAt) ? updatedAt : 0,
            eventCount: Number.isFinite(eventCount) ? eventCount : 0,
          },
        ];
      }),
    );
  }
  return transcripts.toSorted(
    (a, b) =>
      b.updatedAt - a.updatedAt ||
      a.agentId.localeCompare(b.agentId) ||
      a.sessionId.localeCompare(b.sessionId),
  );
}

export function getSqliteSessionTranscriptStats(
  options: SqliteSessionTranscriptStoreOptions,
): Pick<SqliteSessionTranscript, "sessionId" | "updatedAt" | "eventCount"> | null {
  const { sessionId } = normalizeTranscriptScope(options);
  const database = openTranscriptAgentDatabase(options);
  const row = executeSqliteQueryTakeFirstSync(
    database.db,
    getAgentTranscriptKysely(database.db)
      .selectFrom("transcript_events")
      .select([
        (eb) => eb.fn.max<number | bigint>("created_at").as("updated_at"),
        (eb) => eb.fn.countAll<number | bigint>().as("event_count"),
      ])
      .where("session_id", "=", sessionId),
  );
  const eventCount =
    typeof row?.event_count === "bigint" ? Number(row.event_count) : Number(row?.event_count ?? 0);
  if (!Number.isFinite(eventCount) || eventCount <= 0) {
    return null;
  }
  const updatedAt =
    typeof row?.updated_at === "bigint" ? Number(row.updated_at) : Number(row?.updated_at ?? 0);
  return {
    sessionId,
    updatedAt: Number.isFinite(updatedAt) ? updatedAt : 0,
    eventCount,
  };
}

export function projectSqliteSessionTranscriptEvent(
  entry: SqliteSessionTranscriptEvent,
): SqliteSessionTranscriptProjectedEvent {
  const record = asRecord(entry.event);
  const message = asRecord(record?.message);
  const eventId = record ? readRecordString(record, "id") : undefined;
  const eventType = record ? readRecordString(record, "type") : undefined;
  const parentId =
    record && Object.hasOwn(record, "parentId")
      ? record.parentId === null
        ? null
        : readTrimmedString(record.parentId)
      : undefined;
  const toolIds = message
    ? collectMessageToolIds(message)
    : { toolCallIds: [] as string[], toolResultIds: [] as string[] };
  return {
    ...entry,
    ...(eventType ? { eventType } : {}),
    ...(eventId ? { eventId } : {}),
    ...(parentId !== undefined ? { parentId } : {}),
    ...(message ? { messageRole: normalizeProjectedMessageRole(message.role) ?? "other" } : {}),
    toolCallIds: toolIds.toolCallIds,
    toolResultIds: toolIds.toolResultIds,
  };
}

function projectedEventHasTreeLink(entry: SqliteSessionTranscriptProjectedEvent): boolean {
  return (
    entry.eventType !== "session" &&
    typeof entry.eventId === "string" &&
    Object.hasOwn(entry, "parentId")
  );
}

export function selectActiveSqliteSessionTranscriptProjections(
  events: SqliteSessionTranscriptProjectedEvent[],
): SqliteSessionTranscriptProjectedEvent[] {
  if (!events.some(projectedEventHasTreeLink)) {
    return events;
  }

  const byId = new Map<string, SqliteSessionTranscriptProjectedEvent>();
  let leafId: string | undefined;
  for (const event of events) {
    if (event.eventId) {
      byId.set(event.eventId, event);
    }
    if (projectedEventHasTreeLink(event)) {
      leafId = event.eventId;
    }
  }
  if (!leafId) {
    return events;
  }

  const selected: SqliteSessionTranscriptProjectedEvent[] = [];
  const seen = new Set<string>();
  let currentId: string | undefined = leafId;
  while (currentId) {
    if (seen.has(currentId)) {
      return [];
    }
    seen.add(currentId);
    const event = byId.get(currentId);
    if (!event) {
      break;
    }
    selected.push(event);
    currentId = event.parentId ?? undefined;
  }

  const activeBranch = selected.toReversed();
  const firstActiveEvent = activeBranch[0];
  const firstActiveIndex = firstActiveEvent ? events.indexOf(firstActiveEvent) : -1;
  if (firstActiveIndex > 0) {
    for (let index = firstActiveIndex - 1; index >= 0; index -= 1) {
      const event = events[index];
      if (event?.eventType === "compaction") {
        return [event, ...activeBranch];
      }
    }
  }
  return activeBranch;
}

export function loadSqliteSessionTranscriptProjections(
  options: SqliteSessionTranscriptStoreOptions,
): SqliteSessionTranscriptProjectedEvent[] {
  return loadSqliteSessionTranscriptEvents(options).map(projectSqliteSessionTranscriptEvent);
}

export function loadActiveSqliteSessionTranscriptProjections(
  options: SqliteSessionTranscriptStoreOptions,
): SqliteSessionTranscriptProjectedEvent[] {
  return selectActiveSqliteSessionTranscriptProjections(
    loadSqliteSessionTranscriptProjections(options),
  );
}

export function appendSqliteSessionTranscriptEvent(
  options: AppendSqliteSessionTranscriptEventOptions,
): { seq: number } {
  const { agentId, sessionId } = normalizeTranscriptScope(options);
  const now = options.now?.() ?? Date.now();
  const seq = runOpenClawAgentWriteTransaction((database) => {
    const row = executeSqliteQueryTakeFirstSync(
      database.db,
      getAgentTranscriptKysely(database.db)
        .selectFrom("transcript_events")
        .select((eb) =>
          eb(eb.fn.coalesce(eb.fn.max<number | bigint>("seq"), eb.lit(-1)), "+", eb.lit(1)).as(
            "next_seq",
          ),
        )
        .where("session_id", "=", sessionId),
    );
    const nextSeq = typeof row?.next_seq === "bigint" ? Number(row.next_seq) : (row?.next_seq ?? 0);
    insertTranscriptEvent({
      database,
      sessionId,
      seq: nextSeq,
      event: options.event,
      createdAt: now,
    });
    return nextSeq;
  }, options);

  return { seq };
}

export function appendSqliteSessionTranscriptMessage(
  options: AppendSqliteSessionTranscriptMessageOptions,
): { messageId: string } {
  const { agentId, sessionId } = normalizeTranscriptScope(options);
  const now = options.now?.() ?? Date.now();
  const idempotencyKey = readMessageIdempotencyKey(options.message);
  const messageId = runOpenClawAgentWriteTransaction((database) => {
    const db = getAgentTranscriptKysely(database.db);
    const nextSeqRow = executeSqliteQueryTakeFirstSync(
      database.db,
      db
        .selectFrom("transcript_events")
        .select((eb) =>
          eb(eb.fn.coalesce(eb.fn.max<number | bigint>("seq"), eb.lit(-1)), "+", eb.lit(1)).as(
            "next_seq",
          ),
        )
        .where("session_id", "=", sessionId),
    );
    let nextSeq =
      typeof nextSeqRow?.next_seq === "bigint"
        ? Number(nextSeqRow.next_seq)
        : (nextSeqRow?.next_seq ?? 0);

    if (nextSeq === 0) {
      insertTranscriptEvent({
        database,
        sessionId,
        seq: nextSeq,
        event: {
          type: "session",
          version: options.sessionVersion,
          id: sessionId,
          timestamp: new Date(now).toISOString(),
          cwd: options.cwd ?? process.cwd(),
        },
        createdAt: now,
      });
      nextSeq += 1;
    }

    if (idempotencyKey) {
      const existing = executeSqliteQueryTakeFirstSync(
        database.db,
        db
          .selectFrom("transcript_event_identities")
          .select(["event_id"])
          .where("session_id", "=", sessionId)
          .where("message_idempotency_key", "=", idempotencyKey)
          .limit(1),
      );
      if (typeof existing?.event_id === "string") {
        return existing.event_id;
      }
    }

    const tail = executeSqliteQueryTakeFirstSync(
      database.db,
      db
        .selectFrom("transcript_event_identities")
        .select(["event_id"])
        .where("session_id", "=", sessionId)
        .where("event_type", "!=", "session")
        .where("has_parent", "=", 1)
        .orderBy("seq", "desc")
        .limit(1),
    );
    const newMessageId = randomUUID();
    insertTranscriptEvent({
      database,
      sessionId,
      seq: nextSeq,
      event: {
        type: "message",
        id: newMessageId,
        parentId: typeof tail?.event_id === "string" ? tail.event_id : null,
        timestamp: new Date(now).toISOString(),
        message: options.message,
      },
      createdAt: now,
    });
    return newMessageId;
  }, options);

  return { messageId };
}

export function replaceSqliteSessionTranscriptEvents(
  options: ReplaceSqliteSessionTranscriptEventsOptions,
): { replaced: number } {
  const { agentId, sessionId } = normalizeTranscriptScope(options);
  const now = options.now?.() ?? Date.now();
  runOpenClawAgentWriteTransaction((database) => {
    executeSqliteQuerySync(
      database.db,
      getAgentTranscriptKysely(database.db)
        .deleteFrom("transcript_events")
        .where("session_id", "=", sessionId),
    );
    options.events.forEach((event, seq) => {
      insertTranscriptEvent({ database, sessionId, seq, event, createdAt: now });
    });
  }, options);

  return { replaced: options.events.length };
}

export function loadSqliteSessionTranscriptEvents(
  options: SqliteSessionTranscriptStoreOptions,
): SqliteSessionTranscriptEvent[] {
  const { sessionId } = normalizeTranscriptScope(options);
  const database = openTranscriptAgentDatabase(options);
  return executeSqliteQuerySync(
    database.db,
    getAgentTranscriptKysely(database.db)
      .selectFrom("transcript_events")
      .select(["seq", "event_json", "created_at"])
      .where("session_id", "=", sessionId)
      .orderBy("seq", "asc"),
  ).rows.map((row) => {
    const record = row;
    const seq = typeof record.seq === "bigint" ? Number(record.seq) : record.seq;
    return {
      seq,
      event: parseTranscriptEventJson(record.event_json, seq),
      createdAt: parseCreatedAt(record.created_at),
    };
  });
}

export function hasSqliteSessionTranscriptEvents(
  options: SqliteSessionTranscriptStoreOptions,
): boolean {
  const { sessionId } = normalizeTranscriptScope(options);
  const database = openTranscriptAgentDatabase(options);
  const row = executeSqliteQueryTakeFirstSync(
    database.db,
    getAgentTranscriptKysely(database.db)
      .selectFrom("transcript_events")
      .select((eb) => eb.lit(1).as("found"))
      .where("session_id", "=", sessionId)
      .limit(1),
  );
  return row?.found !== undefined;
}

export function recordSqliteSessionTranscriptSnapshot(
  options: SqliteSessionTranscriptStoreOptions & {
    snapshotId: string;
    reason: string;
    eventCount: number;
    createdAt?: number;
    metadata?: unknown;
  },
): void {
  const { sessionId } = normalizeTranscriptScope(options);
  const snapshotId = normalizeSessionId(options.snapshotId);
  const reason = options.reason.trim() || "snapshot";
  const eventCount = Math.max(0, Math.floor(options.eventCount));
  const createdAt = options.createdAt ?? Date.now();
  runOpenClawAgentWriteTransaction((database) => {
    executeSqliteQuerySync(
      database.db,
      getAgentTranscriptKysely(database.db)
        .insertInto("transcript_snapshots")
        .values({
          session_id: sessionId,
          snapshot_id: snapshotId,
          reason,
          event_count: eventCount,
          created_at: createdAt,
          metadata_json: JSON.stringify(options.metadata ?? {}),
        })
        .onConflict((conflict) =>
          conflict.columns(["session_id", "snapshot_id"]).doUpdateSet({
            reason: (eb) => eb.ref("excluded.reason"),
            event_count: (eb) => eb.ref("excluded.event_count"),
            created_at: (eb) => eb.ref("excluded.created_at"),
            metadata_json: (eb) => eb.ref("excluded.metadata_json"),
          }),
        ),
    );
  }, options);
}

export function hasSqliteSessionTranscriptSnapshot(
  options: SqliteSessionTranscriptStoreOptions & { snapshotId: string },
): boolean {
  const { sessionId } = normalizeTranscriptScope(options);
  const snapshotId = normalizeSessionId(options.snapshotId);
  const database = openTranscriptAgentDatabase(options);
  const row = executeSqliteQueryTakeFirstSync(
    database.db,
    getAgentTranscriptKysely(database.db)
      .selectFrom("transcript_snapshots")
      .select((eb) => eb.lit(1).as("found"))
      .where("session_id", "=", sessionId)
      .where("snapshot_id", "=", snapshotId)
      .limit(1),
  );
  return row?.found !== undefined;
}

export function deleteSqliteSessionTranscriptSnapshot(
  options: SqliteSessionTranscriptStoreOptions & { snapshotId: string },
): boolean {
  const { sessionId } = normalizeTranscriptScope(options);
  const snapshotId = normalizeSessionId(options.snapshotId);
  return runOpenClawAgentWriteTransaction((database) => {
    const result = executeSqliteQuerySync(
      database.db,
      getAgentTranscriptKysely(database.db)
        .deleteFrom("transcript_snapshots")
        .where("session_id", "=", sessionId)
        .where("snapshot_id", "=", snapshotId),
    );
    return Number(result.numAffectedRows ?? 0) > 0;
  }, options);
}

export function deleteSqliteSessionTranscript(
  options: SqliteSessionTranscriptStoreOptions,
): boolean {
  const { sessionId } = normalizeTranscriptScope(options);
  const removed = runOpenClawAgentWriteTransaction((database) => {
    executeSqliteQuerySync(
      database.db,
      getAgentTranscriptKysely(database.db)
        .deleteFrom("transcript_snapshots")
        .where("session_id", "=", sessionId),
    );
    const events = executeSqliteQuerySync(
      database.db,
      getAgentTranscriptKysely(database.db)
        .deleteFrom("transcript_events")
        .where("session_id", "=", sessionId),
    );
    return Number(events.numAffectedRows ?? 0) > 0;
  }, options);
  return removed;
}

export function exportSqliteSessionTranscriptJsonl(
  options: ExportSqliteTranscriptJsonlOptions,
): string {
  const lines = loadSqliteSessionTranscriptEvents(options).map((entry) =>
    JSON.stringify(entry.event),
  );
  return lines.length > 0 ? `${lines.join("\n")}\n` : "";
}
