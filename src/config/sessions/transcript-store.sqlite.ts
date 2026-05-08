import { randomUUID } from "node:crypto";
import path from "node:path";
import type { Insertable } from "kysely";
import { sql } from "kysely";
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
import type { DB as OpenClawStateKyselyDatabase } from "../../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../../state/openclaw-state-db.js";
import { parseSqliteSessionTranscriptLocator } from "./paths.js";

export type SqliteSessionTranscriptEvent = {
  seq: number;
  event: unknown;
  createdAt: number;
};

export type SqliteSessionTranscriptStoreOptions = OpenClawStateDatabaseOptions & {
  agentId: string;
  sessionId: string;
};

export type AppendSqliteSessionTranscriptEventOptions = SqliteSessionTranscriptStoreOptions & {
  event: unknown;
  transcriptPath?: string;
  now?: () => number;
};

export type AppendSqliteSessionTranscriptMessageOptions = SqliteSessionTranscriptStoreOptions & {
  cwd?: string;
  message: unknown;
  now?: () => number;
  sessionVersion: number;
  transcriptPath?: string;
};

export type ReplaceSqliteSessionTranscriptEventsOptions = SqliteSessionTranscriptStoreOptions & {
  events: unknown[];
  transcriptPath?: string;
  now?: () => number;
};

export type ExportSqliteTranscriptJsonlOptions = SqliteSessionTranscriptStoreOptions;

export type SqliteSessionTranscriptScope = {
  agentId: string;
  sessionId: string;
};

export type SqliteSessionTranscriptFile = SqliteSessionTranscriptScope & {
  path: string;
  updatedAt: number;
};

export type SqliteSessionTranscript = SqliteSessionTranscriptScope & {
  path?: string;
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

type TranscriptFilesTable = OpenClawStateKyselyDatabase["transcript_files"];
type TranscriptEventsTable = OpenClawAgentKyselyDatabase["transcript_events"];
type TranscriptEventIdentitiesTable = OpenClawAgentKyselyDatabase["transcript_event_identities"];
type StateTranscriptDatabase = Pick<OpenClawStateKyselyDatabase, "transcript_files">;
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

function getStateTranscriptKysely(db: import("node:sqlite").DatabaseSync) {
  return getNodeSqliteKysely<StateTranscriptDatabase>(db);
}

function getAgentTranscriptKysely(db: import("node:sqlite").DatabaseSync) {
  return getNodeSqliteKysely<AgentTranscriptDatabase>(db);
}

function bindTranscriptFile(params: {
  agentId: string;
  sessionId: string;
  path: string;
  importedAt?: number;
  exportedAt?: number;
}): Insertable<TranscriptFilesTable> {
  return {
    agent_id: params.agentId,
    session_id: params.sessionId,
    path: params.path,
    imported_at: params.importedAt ?? null,
    exported_at: params.exportedAt ?? null,
  };
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

function rememberTranscriptFile(params: {
  agentId: string;
  sessionId: string;
  transcriptPath?: string;
  importedAt?: number;
  exportedAt?: number;
  options?: OpenClawStateDatabaseOptions;
}): void {
  const transcriptPath = params.transcriptPath?.trim();
  if (!transcriptPath) {
    return;
  }
  if (parseSqliteSessionTranscriptLocator(transcriptPath)) {
    return;
  }
  const resolvedTranscriptPath = path.resolve(transcriptPath);
  runOpenClawStateWriteTransaction((database) => {
    executeSqliteQuerySync(
      database.db,
      getStateTranscriptKysely(database.db)
        .insertInto("transcript_files")
        .values(
          bindTranscriptFile({
            agentId: params.agentId,
            sessionId: params.sessionId,
            path: resolvedTranscriptPath,
            importedAt: params.importedAt,
            exportedAt: params.exportedAt,
          }),
        )
        .onConflict((conflict) =>
          conflict.columns(["agent_id", "session_id", "path"]).doUpdateSet({
            imported_at: () => sql`COALESCE(excluded.imported_at, transcript_files.imported_at)`,
            exported_at: () => sql`COALESCE(excluded.exported_at, transcript_files.exported_at)`,
          }),
        ),
    );
  }, params.options);
}

export function resolveSqliteSessionTranscriptScopeForPath(
  options: OpenClawStateDatabaseOptions & { transcriptPath: string },
): SqliteSessionTranscriptScope | undefined {
  const parsedLocator = parseSqliteSessionTranscriptLocator(options.transcriptPath);
  if (parsedLocator) {
    return parsedLocator;
  }
  const transcriptPath = path.resolve(options.transcriptPath);
  const database = openOpenClawStateDatabase(options);
  const row = executeSqliteQueryTakeFirstSync<{ agent_id?: unknown; session_id?: unknown }>(
    database.db,
    getStateTranscriptKysely(database.db)
      .selectFrom("transcript_files")
      .select(["agent_id", "session_id"])
      .where("path", "=", transcriptPath)
      .orderBy(sql`COALESCE(imported_at, exported_at, 0)`, "desc")
      .limit(1),
  );
  if (typeof row?.agent_id !== "string" || typeof row.session_id !== "string") {
    return undefined;
  }
  return {
    agentId: normalizeAgentId(row.agent_id),
    sessionId: normalizeSessionId(row.session_id),
  };
}

export function resolveSqliteSessionTranscriptScope(
  options: OpenClawStateDatabaseOptions & {
    agentId?: string;
    sessionId: string;
    transcriptPath?: string;
  },
): SqliteSessionTranscriptScope | undefined {
  const sessionId = normalizeSessionId(options.sessionId);
  if (options.agentId?.trim()) {
    return {
      agentId: normalizeAgentId(options.agentId),
      sessionId,
    };
  }
  if (options.transcriptPath?.trim()) {
    const byPath = resolveSqliteSessionTranscriptScopeForPath({
      ...options,
      transcriptPath: options.transcriptPath,
    });
    if (byPath?.sessionId === sessionId) {
      return byPath;
    }
  }
  const latest = listSqliteSessionTranscripts(options).find(
    (transcript) => transcript.sessionId === sessionId,
  );
  if (!latest) {
    return undefined;
  }
  return {
    agentId: latest.agentId,
    sessionId: latest.sessionId,
  };
}

export function listSqliteSessionTranscriptFiles(
  options: OpenClawStateDatabaseOptions = {},
): SqliteSessionTranscriptFile[] {
  const database = openOpenClawStateDatabase(options);
  return executeSqliteQuerySync<{
    agent_id?: unknown;
    session_id?: unknown;
    path?: unknown;
    updated_at?: unknown;
  }>(
    database.db,
    getStateTranscriptKysely(database.db)
      .selectFrom("transcript_files as files")
      .select([
        "files.agent_id",
        "files.session_id",
        "files.path",
        sql<
          number | bigint
        >`MAX(COALESCE(files.imported_at, 0), COALESCE(files.exported_at, 0))`.as("updated_at"),
      ])
      .groupBy(["files.agent_id", "files.session_id", "files.path"])
      .orderBy("updated_at", "desc")
      .orderBy("files.path", "asc"),
  ).rows.flatMap((row) => {
    const record = row;
    if (
      typeof record.agent_id !== "string" ||
      typeof record.session_id !== "string" ||
      typeof record.path !== "string"
    ) {
      return [];
    }
    const updatedAt =
      typeof record.updated_at === "bigint"
        ? Number(record.updated_at)
        : Number(record.updated_at ?? 0);
    return [
      {
        agentId: normalizeAgentId(record.agent_id),
        sessionId: normalizeSessionId(record.session_id),
        path: record.path,
        updatedAt: Number.isFinite(updatedAt) ? updatedAt : 0,
      },
    ];
  });
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
  const stateDatabase = openOpenClawStateDatabase(options);
  for (const agentDatabase of agentDatabases) {
    const database = openOpenClawAgentDatabase({
      ...options,
      agentId: agentDatabase.agentId,
      ...(agentDatabase.path ? { path: agentDatabase.path } : {}),
    });
    transcripts.push(
      ...executeSqliteQuerySync<{
        session_id?: unknown;
        updated_at?: unknown;
        event_count?: unknown;
      }>(
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
        const pathRow = executeSqliteQueryTakeFirstSync<{ path?: unknown }>(
          stateDatabase.db,
          getStateTranscriptKysely(stateDatabase.db)
            .selectFrom("transcript_files")
            .select(["path"])
            .where("agent_id", "=", agentDatabase.agentId)
            .where("session_id", "=", record.session_id)
            .orderBy(sql`COALESCE(imported_at, exported_at, 0)`, "desc")
            .orderBy("path", "asc")
            .limit(1),
        );
        const path = typeof pathRow?.path === "string" ? pathRow.path : undefined;
        return [
          {
            agentId: agentDatabase.agentId,
            sessionId: normalizeSessionId(record.session_id),
            path,
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
  const database = openOpenClawAgentDatabase(options);
  const row = executeSqliteQueryTakeFirstSync<{ updated_at?: unknown; event_count?: unknown }>(
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

export function appendSqliteSessionTranscriptEvent(
  options: AppendSqliteSessionTranscriptEventOptions,
): { seq: number } {
  const { agentId, sessionId } = normalizeTranscriptScope(options);
  const now = options.now?.() ?? Date.now();
  const seq = runOpenClawAgentWriteTransaction((database) => {
    const row = executeSqliteQueryTakeFirstSync<{ next_seq?: number | bigint }>(
      database.db,
      getAgentTranscriptKysely(database.db)
        .selectFrom("transcript_events")
        .select(sql<number | bigint>`COALESCE(MAX(seq), -1) + 1`.as("next_seq"))
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

  rememberTranscriptFile({
    agentId,
    sessionId,
    transcriptPath: options.transcriptPath,
    importedAt: now,
    options,
  });
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
    const nextSeqRow = executeSqliteQueryTakeFirstSync<{ next_seq?: number | bigint }>(
      database.db,
      db
        .selectFrom("transcript_events")
        .select(sql<number | bigint>`COALESCE(MAX(seq), -1) + 1`.as("next_seq"))
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
      const existing = executeSqliteQueryTakeFirstSync<{ event_id?: unknown }>(
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

    const tail = executeSqliteQueryTakeFirstSync<{ event_id?: unknown }>(
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

  rememberTranscriptFile({
    agentId,
    sessionId,
    transcriptPath: options.transcriptPath,
    importedAt: now,
    options,
  });
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

  rememberTranscriptFile({
    agentId,
    sessionId,
    transcriptPath: options.transcriptPath,
    importedAt: now,
    options,
  });
  return { replaced: options.events.length };
}

export function loadSqliteSessionTranscriptEvents(
  options: SqliteSessionTranscriptStoreOptions,
): SqliteSessionTranscriptEvent[] {
  const { sessionId } = normalizeTranscriptScope(options);
  const database = openOpenClawAgentDatabase(options);
  return executeSqliteQuerySync<{ seq: number | bigint; event_json: unknown; created_at: unknown }>(
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
  const database = openOpenClawAgentDatabase(options);
  const row = executeSqliteQueryTakeFirstSync<{ found?: number | bigint }>(
    database.db,
    getAgentTranscriptKysely(database.db)
      .selectFrom("transcript_events")
      .select(sql<number>`1`.as("found"))
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
  const database = openOpenClawAgentDatabase(options);
  const row = executeSqliteQueryTakeFirstSync<{ found?: number | bigint }>(
    database.db,
    getAgentTranscriptKysely(database.db)
      .selectFrom("transcript_snapshots")
      .select(sql<number>`1`.as("found"))
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
  const { agentId, sessionId } = normalizeTranscriptScope(options);
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
  runOpenClawStateWriteTransaction((database) => {
    executeSqliteQuerySync(
      database.db,
      getStateTranscriptKysely(database.db)
        .deleteFrom("transcript_files")
        .where("agent_id", "=", agentId)
        .where("session_id", "=", sessionId),
    );
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
