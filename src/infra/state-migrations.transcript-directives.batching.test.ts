import { afterEach, expect, it, vi } from "vitest";
import {
  readSqliteTranscriptPayload,
  sqliteTranscriptPayloadColumns,
} from "../../scripts/lib/sqlite-transcript-payload.mjs";
import { cleanupTempDirs, makeTempDir } from "../../test/helpers/temp-dir.js";
import { deriveTranscriptPredicateFields } from "../config/sessions/transcript-predicate-fields.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { requireNativeSqliteDatabase } from "../test-utils/native-sqlite.js";
import { requireNodeSqlite } from "./node-sqlite.js";
import { migrateHistoricalTranscriptDirectives } from "./state-migrations.transcript-directives.js";

const tempDirs: string[] = [];
type FixtureEvent = Record<string, unknown>;
function messageEvent(params: {
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

function insertSession(
  database: import("node:sqlite").DatabaseSync,
  params: {
    events: FixtureEvent[];
    generation: string;
    sessionId: string;
  },
) {
  const key = "agent:main:" + params.sessionId;
  database
    .prepare(
      "INSERT INTO session_nodes(session_key,current_session_id,entry_json,updated_at) VALUES(?,?,'{}',1)",
    )
    .run(key, params.sessionId);
  database
    .prepare(
      "INSERT INTO session_windows(session_id,session_key,created_at,updated_at) VALUES(?,?,1,1)",
    )
    .run(params.sessionId, key);
  database
    .prepare(
      "INSERT INTO transcript_rewrite_watermarks(session_id,generation,updated_at) VALUES(?,?,1)",
    )
    .run(params.sessionId, params.generation);
  const insert = database.prepare(
    "INSERT INTO transcript_events(session_id,seq,event_json,created_at,navigation_type,navigation_custom_type,navigation_display,message_role,navigation_last_type,navigation_last_custom_type,navigation_valid) VALUES($sessionId,$seq,$eventJson,1,$navigation_type,$navigation_custom_type,$navigation_display,$message_role,$navigation_last_type,$navigation_last_custom_type,$navigation_valid)",
  );
  for (const [seq, event] of params.events.entries()) {
    const eventJson = JSON.stringify(event);
    insert.run({
      sessionId: params.sessionId,
      seq,
      eventJson,
      ...deriveTranscriptPredicateFields(eventJson),
    });
  }
}

function readEventJson(databasePath: string, sessionId: string, seq: number): string {
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

function readGeneration(databasePath: string, sessionId: string): string {
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

function readMigrationCursor(databasePath: string): unknown {
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

afterEach(() => {
  vi.restoreAllMocks();
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  cleanupTempDirs(tempDirs);
});

it("resumes a partially committed session without advancing its cursor", async () => {
  const env = { OPENCLAW_STATE_DIR: makeTempDir(tempDirs, "transcript-partial-") };
  const opened = openOpenClawAgentDatabase({ agentId: "main", env });
  const sessionId = "partial-session";
  insertSession(opened.db, {
    sessionId,
    generation: "before",
    events: Array.from({ length: 130 }, (_, seq) =>
      messageEvent({
        id: String(seq),
        role: "assistant",
        timestamp: seq + 1,
        content: [{ type: "text", text: "[[reply_to_current]] Answer " + seq }],
      }),
    ),
  });
  closeOpenClawAgentDatabasesForTest();
  const transcriptStore =
    await import("../config/sessions/session-accessor.sqlite-transcript-store.js");
  const update = transcriptStore.updateSqliteTranscriptEventJsonInTransaction;
  let batches = 0;
  const fault = vi
    .spyOn(transcriptStore, "updateSqliteTranscriptEventJsonInTransaction")
    .mockImplementation((...args) => {
      if (++batches === 2) {
        throw new Error("synthetic batch interruption");
      }
      return update(...args);
    });
  const interrupted = await migrateHistoricalTranscriptDirectives({ env });
  fault.mockRestore();
  expect(interrupted.warnings).toEqual([expect.stringContaining("synthetic batch interruption")]);
  expect(readMigrationCursor(opened.path)).toBeUndefined();
  expect(JSON.parse(readEventJson(opened.path, sessionId, 63)).message.content).toEqual([
    { type: "text", text: "Answer 63" },
  ]);
  expect(JSON.parse(readEventJson(opened.path, sessionId, 64)).message.content).toEqual([
    { type: "text", text: "[[reply_to_current]] Answer 64" },
  ]);
  expect((await migrateHistoricalTranscriptDirectives({ env })).warnings).toEqual([]);
  for (let seq = 0; seq < 130; seq++) {
    expect(JSON.parse(readEventJson(opened.path, sessionId, seq)).message.content).toEqual([
      { type: "text", text: "Answer " + seq },
    ]);
  }
  expect(readMigrationCursor(opened.path)).toEqual({ phase: "complete" });
});

it.each(["replace", "delete", "insert"])(
  "revalidates %s source changes inside the repair transaction",
  async (change) => {
    const env = { OPENCLAW_STATE_DIR: makeTempDir(tempDirs, "transcript-source-") };
    const opened = openOpenClawAgentDatabase({ agentId: "main", env });
    const sessionId = "changed-source";
    insertSession(opened.db, {
      sessionId,
      generation: "before",
      events: [
        messageEvent({
          id: "original",
          role: "assistant",
          timestamp: 1,
          content: [{ type: "text", text: "[[reply_to_current]] Original" }],
        }),
      ],
    });
    const original = readEventJson(opened.path, sessionId, 0);
    closeOpenClawAgentDatabasesForTest();
    const transactions = await import("./sqlite-transaction.js");
    const run = transactions.runSqliteImmediateTransactionSync;
    let mutated = false;
    const fault = vi
      .spyOn(transactions, "runSqliteImmediateTransactionSync")
      .mockImplementation((db, operation, options) => {
        if (!mutated && options?.operationLabel === "historical-transcript-directives") {
          mutated = true;
          const native = requireNativeSqliteDatabase(db);
          if (change === "delete") {
            native.prepare("DELETE FROM transcript_events WHERE session_id = ?").run(sessionId);
          } else if (change === "replace") {
            native
              .prepare("UPDATE transcript_events SET event_json = ? WHERE session_id = ?")
              .run(original.replace("Original", "Changed"), sessionId);
          } else {
            native
              .prepare(
                "INSERT INTO transcript_events(session_id,seq,event_json,created_at) VALUES(?,1,?,1)",
              )
              .run(sessionId, original);
          }
        }
        return run(db, operation, options);
      });
    const result = await migrateHistoricalTranscriptDirectives({ env });
    fault.mockRestore();
    expect(result.warnings).toEqual([expect.stringContaining("Transcript source changed")]);
    expect(readMigrationCursor(opened.path)).toBeUndefined();
    expect(readGeneration(opened.path, sessionId)).toBe("before");
  },
);
