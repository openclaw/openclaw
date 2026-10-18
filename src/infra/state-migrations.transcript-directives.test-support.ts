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
  return {
    type: "message",
    id: params.id,
    parentId: params.parentId ?? null,
    timestamp: params.timestamp,
    message: {
      role: params.role,
      content: params.content,
      timestamp: params.timestamp,
      ...(params.role === "assistant"
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
  const sessionKey = `agent:main:${params.sessionId}`;
  database
    .prepare(
      `INSERT INTO session_nodes(session_key,current_session_id,entry_json,updated_at)
       VALUES(?,?,?,?)`,
    )
    .run(sessionKey, params.sessionId, "{}", 1);
  database
    .prepare(
      `INSERT INTO session_windows(session_id,session_key,created_at,updated_at,transcript_updated_at)
       VALUES(?,?,?,?,?)`,
    )
    .run(params.sessionId, sessionKey, 1, 1, 1);
  database
    .prepare(
      `INSERT INTO transcript_rewrite_watermarks(session_id,generation,updated_at)
       VALUES(?,?,?)`,
    )
    .run(params.sessionId, params.generation, 1);
  for (const [seq, event] of params.events.entries()) {
    const eventJson = JSON.stringify(event);
    if (params.legacy) {
      database
        .prepare(
          `INSERT INTO transcript_events(session_id,seq,event_json,created_at)
         VALUES(?,?,?,?)`,
        )
        .run(params.sessionId, seq, eventJson, Number(event.timestamp ?? 1));
    } else {
      database
        .prepare(`INSERT INTO transcript_events
        (session_id,seq,event_json,created_at,navigation_type,navigation_custom_type,
         navigation_display,message_role,navigation_last_type,navigation_last_custom_type,navigation_valid)
        VALUES ($sessionId,$seq,$eventJson,$createdAt,$navigation_type,$navigation_custom_type,
          $navigation_display,$message_role,$navigation_last_type,$navigation_last_custom_type,$navigation_valid)`)
        .run({
          sessionId: params.sessionId,
          seq,
          eventJson,
          createdAt: Number(event.timestamp ?? 1),
          ...deriveTranscriptPredicateFields(eventJson),
        });
    }
  }
  if (params.reconcile !== false) {
    reconcileSessionTranscriptIndexInTransaction(database, params.sessionId);
  }
}

export function readEventJson(databasePath: string, sessionId: string, seq: number): string {
  const { DatabaseSync } = requireNodeSqlite();
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const row = database
      .prepare(
        `SELECT ${sqliteTranscriptPayloadColumns(database)} FROM transcript_events WHERE session_id = ? AND seq = ?`,
      )
      .get(sessionId, seq);
    if (!row) {
      throw new Error(`Missing transcript fixture ${sessionId}:${seq}`);
    }
    return readSqliteTranscriptPayload(row);
  } finally {
    database.close();
  }
}

export function readGeneration(databasePath: string, sessionId: string): string {
  const { DatabaseSync } = requireNodeSqlite();
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const row = database
      .prepare("SELECT generation FROM transcript_rewrite_watermarks WHERE session_id = ?")
      .get(sessionId) as { generation: string };
    return row.generation;
  } finally {
    database.close();
  }
}

export function readMigrationCursor(databasePath: string): unknown {
  const { DatabaseSync } = requireNodeSqlite();
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const row = database
      .prepare(
        "SELECT app_version FROM schema_meta WHERE meta_key = 'historical-transcript-directives-v1'",
      )
      .get() as { app_version: string } | undefined;
    return row ? JSON.parse(row.app_version) : undefined;
  } finally {
    database.close();
  }
}
