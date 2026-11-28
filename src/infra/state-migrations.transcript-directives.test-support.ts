import type { SQLInputValue } from "node:sqlite";
import {
  readSqliteTranscriptPayload,
  sqliteTranscriptPayloadColumns,
} from "../../scripts/lib/sqlite-transcript-payload.mjs";
import { createZeroUsageFixture } from "../agents/test-helpers/usage-fixtures.js";
import { reconcileSessionTranscriptIndexInTransaction } from "../config/sessions/session-transcript-index.js";
import { deriveTranscriptPredicateFields } from "../config/sessions/transcript-predicate-fields.js";
import { requireNodeSqlite } from "./node-sqlite.js";

export type FixtureEvent = Record<string, unknown>;

export const textEvent = (
  id: string,
  text: string,
  timestamp = 1,
  role: "assistant" | "toolResult" | "user" = "assistant",
  parentId?: string,
) => messageEvent({ id, timestamp, role, parentId, content: [{ type: "text", text }] });

function messageEvent(params: {
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
            usage: createZeroUsageFixture(),
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

export function readDatabaseRow(databasePath: string, sql: string, ...values: SQLInputValue[]) {
  const { DatabaseSync } = requireNodeSqlite();
  using database = new DatabaseSync(databasePath, { readOnly: true });
  return database.prepare(sql).get(...values);
}

export function readMigrationCursor(databasePath: string): unknown {
  const row = readDatabaseRow(
    databasePath,
    "SELECT app_version FROM schema_meta WHERE meta_key = 'historical-transcript-directives-v1'",
  ) as { app_version: string } | undefined;
  return row ? JSON.parse(row.app_version) : undefined;
}
