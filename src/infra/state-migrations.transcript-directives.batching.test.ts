import type { StatementSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { cleanupTempDirs, makeTempDir } from "../../test/helpers/temp-dir.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { requireNativeSqliteDatabase } from "../test-utils/native-sqlite.js";
import { requireNodeSqlite } from "./node-sqlite.js";
import { migrateHistoricalTranscriptDirectives } from "./state-migrations.transcript-directives.js";
import {
  insertSession,
  readDatabaseRow,
  readEventJson,
  readMigrationCursor,
  textEvent,
} from "./state-migrations.transcript-directives.test-support.js";

const tempDirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  cleanupTempDirs(tempDirs);
});

it("resumes a partially committed session without skipping repairs or duplicating provider receipts", async () => {
  const env = { OPENCLAW_STATE_DIR: makeTempDir(tempDirs, "transcript-batch-") };
  const opened = openOpenClawAgentDatabase({ agentId: "main", env });
  const database = requireNativeSqliteDatabase(opened.db);
  const databasePath = opened.path;
  const sessionId = "batched-session";
  const events = Array.from({ length: 130 }, (_, seq) => {
    const event = textEvent(`batch-${seq}`, `[[reply_to_current]] Answer ${seq}`, seq + 1);
    Object.assign(event.message as Record<string, unknown>, {
      model: "fixture-model",
      provider: "***",
    });
    return event;
  });
  insertSession(database, { events, generation: "before", sessionId });
  database
    .prepare(`INSERT INTO trajectory_runtime_events
    (session_id,seq,run_id,event_json,created_at) VALUES(?,0,'synthetic',?,1)`)
    .run(sessionId, JSON.stringify({ modelId: "fixture-model", provider: "fixture-provider" }));
  closeOpenClawAgentDatabasesForTest();
  const prototype = requireNodeSqlite().StatementSync.prototype;
  // oxlint-disable-next-line typescript/unbound-method -- Forwarded with its native statement receiver.
  const originalRun = prototype.run;
  const fault = vi.spyOn(prototype, "run").mockImplementation(
    new Proxy(originalRun, {
      apply(run, statement: StatementSync, args) {
        if (
          statement.sourceSQL.startsWith('update "transcript_events"') &&
          args.at(-2) === sessionId &&
          args.at(-1) === 64
        ) {
          throw new Error("synthetic transcript interruption");
        }
        return Reflect.apply(run, statement, args);
      },
    }),
  );
  const interrupted = await migrateHistoricalTranscriptDirectives({ env }).finally(() =>
    fault.mockRestore(),
  );
  expect(interrupted.warnings).toEqual([
    expect.stringContaining("synthetic transcript interruption"),
  ]);
  expect(readMigrationCursor(databasePath)).toBeUndefined();
  const receipts = () =>
    JSON.parse(
      String(
        readDatabaseRow(
          databasePath,
          "SELECT app_version FROM schema_meta WHERE meta_key = ?",
          "historical-transcript-masked-provider-restored-v1",
        )?.app_version,
      ),
    );
  expect(receipts()).toEqual({
    archiveLines: [],
    transcriptRows: { [sessionId]: Array.from({ length: 64 }, (_, seq) => seq) },
  });
  expect(JSON.parse(readEventJson(databasePath, sessionId, 63))).toMatchObject({
    message: {
      provider: "fixture-provider",
      content: [{ type: "text", text: "Answer 63" }],
    },
  });
  expect(readEventJson(databasePath, sessionId, 64)).toBe(JSON.stringify(events[64]));
  expect((await migrateHistoricalTranscriptDirectives({ env })).warnings).toEqual([]);
  for (let seq = 0; seq < events.length; seq++) {
    expect(JSON.parse(readEventJson(databasePath, sessionId, seq))).toMatchObject({
      message: {
        provider: "fixture-provider",
        content: [{ type: "text", text: `Answer ${seq}` }],
      },
    });
  }
  expect(receipts()).toEqual({
    archiveLines: [],
    transcriptRows: { [sessionId]: events.map((_, seq) => seq) },
  });
  expect(readMigrationCursor(databasePath)).toEqual({ phase: "complete", version: 2 });
});
