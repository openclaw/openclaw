import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { expect } from "vitest";
import {
  readSqliteTranscriptPayload,
  sqliteTranscriptPayloadColumns,
} from "../../scripts/lib/sqlite-transcript-payload.mjs";
import { createZeroUsageFixture } from "../agents/test-helpers/usage-fixtures.js";
import { resolveSqliteTranscriptArchiveDirectory } from "../config/sessions/session-accessor.sqlite-scope.js";
import { reconcileSessionTranscriptIndexInTransaction } from "../config/sessions/session-transcript-index.js";
import { prepareTranscriptPayload } from "../config/sessions/transcript-payload.js";
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

export function insertArchive(
  database: DatabaseSync,
  bytes: Uint8Array,
  archiveName: string,
  sessionId: string,
  {
    generation = "generation",
    encoding = "identity",
    createdAt = 1,
    publishedAt = null,
  }: {
    generation?: string;
    encoding?: string;
    createdAt?: number;
    publishedAt?: number | null;
  } = {},
) {
  database
    .prepare(`INSERT INTO session_transcript_archives(
    session_id,generation,session_key,reason,encoding,archive_blob,archive_sha256,
    archive_name,created_at,published_at) VALUES(?,?,?,'deleted',?,?,?,?,?,?)`)
    .run(
      sessionId,
      generation,
      `agent:main:${sessionId}`,
      encoding,
      bytes,
      createHash("sha256").update(bytes).digest("hex"),
      archiveName,
      createdAt,
      publishedAt,
    );
}

export function writeArchiveCopy(databasePath: string, archiveName: string, bytes: Uint8Array) {
  const directory = resolveSqliteTranscriptArchiveDirectory({
    agentId: "main",
    path: databasePath,
  });
  fs.mkdirSync(directory, { recursive: true });
  const archivePath = path.join(directory, archiveName);
  fs.writeFileSync(archivePath, bytes);
  return archivePath;
}

export function writeMetadata(
  database: DatabaseSync,
  value: unknown,
  key = "historical-transcript-directives-v1",
) {
  database
    .prepare(`INSERT INTO schema_meta(
    meta_key,role,schema_version,agent_id,app_version,created_at,updated_at)
    VALUES(?,'agent',1,'main',?,1,1)`)
    .run(key, JSON.stringify(value));
}

export function compressTranscriptRows(database: DatabaseSync) {
  const update = database.prepare(
    "UPDATE transcript_events SET event_json = NULL, event_zstd = ?, event_utf8_bytes = ?, navigation_json = ? WHERE session_id = ? AND seq = ?",
  );
  for (const row of database
    .prepare("SELECT session_id, seq, event_json FROM transcript_events")
    .all()) {
    if (
      typeof row.event_json !== "string" ||
      typeof row.session_id !== "string" ||
      typeof row.seq !== "number"
    ) {
      throw new Error("Invalid transcript fixture row");
    }
    const payload = prepareTranscriptPayload(database, row.event_json);
    expect(payload.event_zstd).not.toBeNull();
    update.run(
      payload.event_zstd,
      payload.event_utf8_bytes,
      payload.navigation_json,
      row.session_id,
      row.seq,
    );
  }
}

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

export function readGeneration(databasePath: string, sessionId: string): string {
  const row = readDatabaseRow(
    databasePath,
    "SELECT generation FROM transcript_rewrite_watermarks WHERE session_id = ?",
    sessionId,
  ) as { generation: string };
  return row.generation;
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
