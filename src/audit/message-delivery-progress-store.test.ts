import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { EngineConnection } from "../infra/sql-connection.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../state/openclaw-state-db-contract.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { recordAuditEventInDatabase } from "./audit-event-store.js";
import type { OutboundMessageProgressInput } from "./audit-event-types.js";
import {
  countOutboundMessageAuditEventsForRunInDatabase,
  pageOutboundMessageAuditEventsForRunInDatabase,
} from "./message-delivery-audit-store.js";
import {
  pruneExpiredOutboundMessageProgressInDatabase,
  recordOutboundMessageProgressInDatabase,
} from "./message-delivery-progress-store.js";
import { assertMessageProgressOverflowRetention } from "./message-progress-retention.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const OUTBOUND_PROGRESS_PRUNE_BATCH_ROWS_CONTRACT = 1_024;

function createStore() {
  const options = { env: { OPENCLAW_STATE_DIR: tempDirs.make("message-progress-") } };
  const open = () => openOpenClawStateDatabase(options);
  const writeOptions = () => ({ ...options, database: open() });
  return {
    open,
    count: (table: string) => open().db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get(),
    recordProgress: (input: OutboundMessageProgressInput) =>
      recordOutboundMessageProgressInDatabase(input, writeOptions()),
    recordTerminal: (input: ReturnType<typeof terminalInput>) =>
      recordAuditEventInDatabase(input, writeOptions()),
    readPage: (
      params: Omit<Parameters<typeof pageOutboundMessageAuditEventsForRunInDatabase>[1], "runId">,
    ) =>
      pageOutboundMessageAuditEventsForRunInDatabase(open().db, {
        runId: "run-progress",
        ...params,
      }),
    prune: (now: number) =>
      pruneExpiredOutboundMessageProgressInDatabase({ database: writeOptions(), now }),
  };
}

function progressInput(
  action: OutboundMessageProgressInput["action"],
  overrides: Partial<OutboundMessageProgressInput> = {},
): OutboundMessageProgressInput {
  const queued = action === "message.outbound.queued";
  return {
    sourceId: queued ? "queue:payload:0:queued" : "queue:payload:0:platform-started",
    sourceSequence: queued ? 1 : 2,
    occurredAt: Date.now(),
    kind: "message",
    action,
    status: "started",
    outcome: queued ? "queued" : "platform_started",
    actorType: "agent",
    actorId: "main",
    agentId: "main",
    runId: "run-progress",
    direction: "outbound",
    channel: "qa-channel",
    conversationKind: "direct",
    durationMs: queued ? 1 : 2,
    resultCount: 0,
    accountId: "raw-account",
    conversationId: "raw-conversation",
    targetId: "raw-target",
    ...overrides,
  } as OutboundMessageProgressInput;
}

function terminalInput(occurredAt = Date.now()) {
  return {
    ...progressInput("message.outbound.queued", { occurredAt }),
    sourceId: "queue:payload:0",
    sourceSequence: 3,
    action: "message.outbound.finished" as const,
    status: "succeeded" as const,
    outcome: "sent" as const,
    durationMs: 3,
    resultCount: 1,
    messageId: "raw-platform-message",
  };
}

function outcomes(page: ReturnType<typeof pageOutboundMessageAuditEventsForRunInDatabase>) {
  return page.entries.map((entry) => entry.event.outcome);
}

function seedProgress(db: EngineConnection, count: number, occurredAt: number, paired = false) {
  db.prepare(`WITH RECURSIVE numbers(n) AS (
      SELECT 0 UNION ALL SELECT n + 1 FROM numbers WHERE n + 1 < ?
    ), stages(stage, action, outcome) AS (VALUES
      (0, 'message.outbound.queued', 'queued'),
      (1, 'message.outbound.platform-started', 'platform_started')
    ) INSERT INTO outbound_message_progress (
      progress_id, source_id, source_sequence, schema_version, occurred_at,
      action, outcome, actor_type, actor_id, agent_id, run_id, channel,
      conversation_kind, duration_ms
    ) SELECT 'progress:' || n || ':' || stage, 'source:' || n || ':' || stage,
      n * 2 + stage + 1, 1, ? + n * ?, action, outcome, 'agent', 'main', 'main',
      'run-progress', 'qa-channel', 'direct', 1
    FROM numbers CROSS JOIN stages WHERE ? = 1 OR stage = 0 ORDER BY n, stage
  `).run(count, occurredAt, Number(paired), Number(paired));
}

afterEach(closeOpenClawStateDatabaseForTest);

describe("outbound message progress companion", () => {
  it("stays absent through startup, reads, and terminal-only writes at the current schema", () => {
    const database = createStore();
    const opened = database.open();
    expect(opened.db.prepare("PRAGMA user_version").get()).toEqual({
      user_version: OPENCLAW_STATE_SCHEMA_VERSION,
    });
    expect(tableExists(opened.db, "outbound_message_progress")).toBe(false);
    expect(tableExists(opened.db, "outbound_message_execution_bindings")).toBe(false);

    expect(
      countOutboundMessageAuditEventsForRunInDatabase(database.open().db, {
        runId: "missing",
      }),
    ).toBe(0);
    expect(tableExists(opened.db, "outbound_message_progress")).toBe(false);

    database.recordTerminal(terminalInput());
    expect(tableExists(opened.db, "outbound_message_progress")).toBe(false);
    expect(tableExists(opened.db, "outbound_message_execution_bindings")).toBe(false);
    expect(
      opened.db
        .prepare("SELECT COUNT(*) AS count FROM audit_events WHERE action != ?")
        .get("message.outbound.finished"),
    ).toEqual({ count: 0 });
  });

  it("ensures idempotently, deduplicates replay, and stores no raw message material", () => {
    const database = createStore();
    const queued = progressInput("message.outbound.queued");
    const first = database.recordProgress(queued);
    closeOpenClawStateDatabaseForTest();
    const recoveredReplay = database.recordProgress(queued);
    database.recordProgress(progressInput("message.outbound.platform-started"));

    expect(first).toMatchObject({ action: "message.outbound.queued", outcome: "queued" });
    expect(recoveredReplay).toBeUndefined();
    const { db } = database.open();
    expect(database.count("outbound_message_progress")).toEqual({ count: 2 });
    expect(database.count("audit_events")).toEqual({ count: 0 });
    const stored = JSON.stringify(
      db.prepare("SELECT * FROM outbound_message_progress ORDER BY sequence").all(),
    );
    for (const raw of ["raw-account", "raw-conversation", "raw-target"]) {
      expect(stored).not.toContain(raw);
    }
  });

  it("pages large offsets across bounded owner-stream chunks", () => {
    const database = createStore();
    const occurredAt = Date.now();
    database.recordProgress(progressInput("message.outbound.queued", { occurredAt }));
    const { db } = database.open();
    db.prepare("DELETE FROM outbound_message_progress").run();
    seedProgress(db, 300, occurredAt, true);

    const page = database.readPage({ now: occurredAt, offset: 510, limit: 4 });
    expect(outcomes(page)).toEqual(["queued", "platform_started", "queued", "platform_started"]);
    expect(page.nextCursor).toBeDefined();
    expect(
      outcomes(database.readPage({ now: occurredAt, after: page.nextCursor, limit: 2 })),
    ).toEqual(["queued", "platform_started"]);
  });

  it("rejects a cursor whose owner row was pruned while preserving the other owner", () => {
    const database = createStore();
    const occurredAt = Date.now();
    database.recordTerminal(terminalInput(occurredAt));
    database.recordProgress(progressInput("message.outbound.queued", { occurredAt }));
    const first = database.readPage({ now: occurredAt, limit: 2 });
    const progress = first.entries.find((entry) => entry.event.outcome === "queued");
    expect(progress).toBeDefined();
    const progressCursor = {
      occurredAt,
      rowId: progress?.rowId ?? 0,
    };
    database.open().db.prepare("DELETE FROM outbound_message_progress").run();

    expect(() => database.readPage({ now: occurredAt, after: progressCursor, limit: 1 })).toThrow(
      "cursor is no longer retained",
    );
    expect(outcomes(database.readPage({ now: occurredAt, limit: 10 }))).toEqual(["sent"]);
  });

  it("bounds expired progress maintenance while preserving retained terminal rows", () => {
    const database = createStore();
    database.recordProgress(progressInput("message.outbound.queued"));
    const { db } = database.open();
    db.exec("DELETE FROM outbound_message_progress");
    const now = Date.now();
    database.recordTerminal(terminalInput(now));
    seedProgress(db, OUTBOUND_PROGRESS_PRUNE_BATCH_ROWS_CONTRACT + 1, now - 31 * 24 * 60 * 60_000);

    expect(database.prune(now)).toBe(OUTBOUND_PROGRESS_PRUNE_BATCH_ROWS_CONTRACT);
    expect(database.count("outbound_message_progress")).toEqual({ count: 1 });
    expect(database.prune(now)).toBe(1);
    expect(database.prune(now)).toBe(0);
    expect(database.count("audit_events")).toEqual({ count: 1 });
  });

  it("prunes overflow with one delete and retains the newest rows across sequence gaps", () => {
    assertMessageProgressOverflowRetention(createStore().open());
  });
});
