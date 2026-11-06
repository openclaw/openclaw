import { channel } from "node:diagnostics_channel";
import fs from "node:fs";
import { threadId } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, test } from "vitest";
import { resolveSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target.js";
import { createSessionTranscriptFtsInserter } from "../config/sessions/session-transcript-fts.js";
import { listSessionsNeedingTranscriptIndexReconcile } from "../config/sessions/session-transcript-index.js";
import { createTranscriptEventInserter } from "../config/sessions/transcript-payload.js";
import { runSqliteImmediateTransactionSync } from "../infra/sqlite-transaction.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { rpcReq, writeSessionStore } from "./test-helpers.js";
import {
  sessionStoreEntry,
  setupGatewaySessionsTestHarness,
} from "./test/server-sessions.test-helpers.js";

const SESSION_ID = "phase3-reclamation-e2e";
const SESSION_KEY = "discord:group:phase3-reclamation-e2e";
const CANONICAL_SESSION_KEY = `agent:main:${SESSION_KEY}`;
const HISTORICAL_SESSION_ID = "phase3-reclamation-e2e-history";
const UNRELATED_SESSION_ID = "phase3-reclamation-unrelated";
const UNRELATED_SESSION_KEY = "discord:group:phase3-reclamation-unrelated";
const { createSessionStoreDir, openClient } = setupGatewaySessionsTestHarness();

function countRows(
  database: ReturnType<typeof openOpenClawAgentDatabase>,
  table: string,
  sessionId: string,
  column = "session_id",
): number {
  const row = database.db
    .prepare(`SELECT count(*) AS count FROM ${table} WHERE ${column} = ?`)
    .get(sessionId) as { count: number | bigint };
  return Number(row.count);
}

function openDatabase(storePath: string) {
  const target = resolveSqliteTargetFromSessionStorePath(storePath, { agentId: "main" });
  if (!target.path) {
    throw new Error("expected SQLite database path");
  }
  return openOpenClawAgentDatabase({ agentId: "main", path: target.path });
}

function seedTranscriptState(storePath: string): void {
  const database = openDatabase(storePath);
  const now = Date.now();
  const message = { content: "phase3 e2e transcript message", role: "user" };
  const eventJson = JSON.stringify({ type: "message", message });
  // The fixture is already projected; NULL eligibility would schedule an
  // unrelated background index rebuild during the deletion measurement.
  const insertActive = database.db.prepare(
    `INSERT INTO session_transcript_active_events
     (session_id, active_position, event_seq, message_position, context_eligible) VALUES (?, ?, ?, ?, 1)`,
  );
  const ftsFields = { text: message.content, role: message.role, timestamp: now };
  const insertIndex = database.db.prepare(
    `INSERT INTO session_transcript_index_state
     (session_id, indexed_seq, needs_rebuild, active_event_count, active_message_count, updated_at)
     VALUES (?, ?, 0, ?, ?, ?)`,
  );
  const insertWatermark = database.db.prepare(
    `INSERT INTO transcript_rewrite_watermarks (session_id, generation, updated_at) VALUES (?, ?, ?)`,
  );
  runSqliteImmediateTransactionSync(database.db, () => {
    database.db
      .prepare(
        `INSERT INTO session_windows (session_id, session_key, reason, session_scope, created_at, updated_at)
         SELECT ?, session_key, 'initial', session_scope, ?, ?
         FROM session_windows WHERE session_id = ?`,
      )
      .run(HISTORICAL_SESSION_ID, now - 1, now - 1, SESSION_ID);
    database.db
      .prepare(
        "UPDATE session_windows SET previous_session_id = ?, reason = 'reset' WHERE session_id = ?",
      )
      .run(HISTORICAL_SESSION_ID, SESSION_ID);
    for (const [sessionId, rows, generation] of [
      [SESSION_ID, 200_000, "phase3-e2e-generation"],
      [HISTORICAL_SESSION_ID, 1, "phase3-e2e-current-generation"],
      [UNRELATED_SESSION_ID, 1, "phase3-unrelated-generation"],
    ] as const) {
      const insertEvent = createTranscriptEventInserter(database.db, sessionId);
      const insertFts = createSessionTranscriptFtsInserter(database.db, sessionId);
      for (let index = 0; index < rows; index += 1) {
        insertEvent({ seq: index, eventJson, createdAt: now + index });
        insertActive.run(sessionId, index, index, index);
      }
      insertFts(
        Array.from({ length: rows }, (_, index) => ({
          ...ftsFields,
          messageId: `${sessionId}-message-${index}`,
        })),
      );
      insertIndex.run(sessionId, rows - 1, rows, rows, now);
      insertWatermark.run(sessionId, generation, now);
    }
  });
  expect(listSessionsNeedingTranscriptIndexReconcile(database.db)).toEqual([]);
}

test("sessions.delete reclaims a large session off the Gateway thread", async () => {
  const { storePath } = await createSessionStoreDir();
  await writeSessionStore({
    entries: {
      [SESSION_KEY]: sessionStoreEntry(SESSION_ID),
      [UNRELATED_SESSION_KEY]: sessionStoreEntry(UNRELATED_SESSION_ID),
    },
    storePath,
  });
  seedTranscriptState(storePath);

  // Client setup prepares reply runtime before the deletion responsiveness window.
  const { ws } = await openClient();
  const diagnostics = channel("openclaw.session.write");
  const reclamations: Record<string, unknown>[] = [];
  const recordReclamation = (message: unknown) => {
    if (
      isRecord(message) &&
      (message.reclamationKind === "historical-generation" ||
        message.reclamationKind === "entry") &&
      (message.operation === "session.reclamation.worker-commit" ||
        message.operation === "session.reclamation.in-process")
    ) {
      reclamations.push(message);
    }
  };
  diagnostics.subscribe(recordReclamation);
  // Allow slow hosts; worker facts below independently prove off-thread execution.
  const deleted = await rpcReq<{ archived: string[] }>(
    ws,
    "sessions.delete",
    { key: SESSION_KEY },
    60_000,
  ).finally(() => {
    diagnostics.unsubscribe(recordReclamation);
    ws.close();
  });

  const database = openDatabase(storePath);
  const archives = database.db
    .prepare(
      `SELECT session_id, archive_sha256, length(archive_blob) AS archive_bytes, published_at
       FROM session_transcript_archives
       WHERE session_id IN (?, ?)
       ORDER BY session_id`,
    )
    .all(SESSION_ID, HISTORICAL_SESSION_ID);

  expect(deleted).toMatchObject({
    ok: true,
    payload: {
      archived: [expect.any(String), expect.any(String)],
      deleted: true,
      key: CANONICAL_SESSION_KEY,
      ok: true,
    },
  });
  expect(deleted.payload?.archived.every((archivePath) => fs.existsSync(archivePath))).toBe(true);
  for (const [sessionId, expected] of [
    [SESSION_ID, 0],
    [HISTORICAL_SESSION_ID, 0],
    [UNRELATED_SESSION_ID, 1],
  ] as const) {
    for (const table of [
      "session_transcript_active_events",
      "session_transcript_fts",
      "session_transcript_fts_rows",
      "session_transcript_index_state",
      "transcript_events",
      "transcript_rewrite_watermarks",
      "session_windows",
    ]) {
      expect(countRows(database, table, sessionId), `${sessionId}: ${table}`).toBe(expected);
    }
    if (sessionId !== HISTORICAL_SESSION_ID) {
      expect(countRows(database, "session_nodes", sessionId, "current_session_id"), sessionId).toBe(
        expected,
      );
    }
  }
  expect(archives).toEqual(
    [SESSION_ID, HISTORICAL_SESSION_ID].map((session_id) => ({
      archive_bytes: expect.any(Number),
      archive_sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      published_at: expect.any(Number),
      session_id,
    })),
  );
  for (const archive of archives) {
    expect(Number(archive.archive_bytes)).toBeGreaterThan(0);
  }
  expect(reclamations).toMatchObject(
    ["historical-generation", "entry"].map((reclamationKind) => ({
      reclamationKind,
      operation: "session.reclamation.worker-commit",
      outcome: "ok",
      threadId,
      writer: "worker",
    })),
  );
  for (const record of reclamations) {
    expect(record.workerThreadId).toBeGreaterThan(0);
    expect(record.workerThreadId).not.toBe(threadId);
  }
}, 120_000);
