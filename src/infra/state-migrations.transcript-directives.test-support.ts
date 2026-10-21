import type { SQLInputValue } from "node:sqlite";
import {
  readSqliteTranscriptPayload,
  sqliteTranscriptPayloadColumns,
} from "../../scripts/lib/sqlite-transcript-payload.mjs";
import { reconcileSessionTranscriptIndexInTransaction } from "../config/sessions/session-transcript-index.js";
import { deriveTranscriptPredicateFields } from "../config/sessions/transcript-predicate-fields.js";
import { requireNodeSqlite } from "./node-sqlite.js";

export type FixtureEvent = Record<string, unknown>;

export function messageEvent(params: {
  content: unknown;
  id: string;
  parentId?: string | null;
  role: "assistant" | "toolResult" | "user";
  timestamp: number;
}): FixtureEvent {
  const { id, parentId, ...message } = params;
  return {
    type: "message",
    id,
    parentId: parentId ?? null,
    timestamp: params.timestamp,
    message: {
      ...message,
      ...(message.role === "assistant"
        ? {
            api: "messages",
            provider: "anthropic",
            model: "sonnet-4.6",
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: "stop",
          }
        : {}),
    },
  };
}

export function insertSession(
  database: import("node:sqlite").DatabaseSync,
  params: {
    events: FixtureEvent[];
    generation: string;
    sessionId: string;
    reconcile?: boolean;
    legacy?: boolean;
  },
): void {
  const { sessionId, generation } = params;
  const sessionKey = `agent:main:${sessionId}`;
  const insert = (table: string, row: Record<string, SQLInputValue>) => {
    const columns = Object.keys(row).join(",");
    const values = Object.values(row);
    const placeholders = values.map(() => "?").join(",");
    database.prepare(`INSERT INTO ${table}(${columns}) VALUES(${placeholders})`).run(...values);
  };
  insert("session_nodes", {
    session_key: sessionKey,
    current_session_id: sessionId,
    entry_json: "{}",
    updated_at: 1,
  });
  insert("session_windows", {
    session_id: sessionId,
    session_key: sessionKey,
    created_at: 1,
    updated_at: 1,
    transcript_updated_at: 1,
  });
  insert("transcript_rewrite_watermarks", { session_id: sessionId, generation, updated_at: 1 });
  for (const [seq, event] of params.events.entries()) {
    const event_json = JSON.stringify(event);
    insert("transcript_events", {
      session_id: sessionId,
      seq,
      event_json,
      created_at: Number(event.timestamp ?? 1),
      ...(params.legacy ? {} : deriveTranscriptPredicateFields(event_json)),
    });
  }
  if (params.reconcile !== false) {
    reconcileSessionTranscriptIndexInTransaction(database, params.sessionId);
  }
}

export function readEventJson(databasePath: string, sessionId: string, seq: number): string {
  const { DatabaseSync } = requireNodeSqlite();
  using database = new DatabaseSync(databasePath, { readOnly: true });
  const row = database
    .prepare(
      `SELECT ${sqliteTranscriptPayloadColumns(database)} FROM transcript_events WHERE session_id = ? AND seq = ?`,
    )
    .get(sessionId, seq);
  if (!row) {
    throw new Error(`Missing transcript fixture ${sessionId}:${seq}`);
  }
  return readSqliteTranscriptPayload(row);
}

export function readGeneration(databasePath: string, sessionId: string): string {
  const { DatabaseSync } = requireNodeSqlite();
  using database = new DatabaseSync(databasePath, { readOnly: true });
  const row = database
    .prepare("SELECT generation FROM transcript_rewrite_watermarks WHERE session_id = ?")
    .get(sessionId) as { generation: string };
  return row.generation;
}

export function readMigrationCursor(databasePath: string): unknown {
  const { DatabaseSync } = requireNodeSqlite();
  using database = new DatabaseSync(databasePath, { readOnly: true });
  const row = database
    .prepare(
      "SELECT app_version FROM schema_meta WHERE meta_key = 'historical-transcript-directives-v1'",
    )
    .get() as { app_version: string } | undefined;
  return row ? JSON.parse(row.app_version) : undefined;
}
