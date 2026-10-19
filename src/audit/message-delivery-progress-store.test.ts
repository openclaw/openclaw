import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
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

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const OUTBOUND_PROGRESS_PRUNE_BATCH_ROWS_CONTRACT = 1_024;

function createStore() {
  const options = { env: { OPENCLAW_STATE_DIR: tempDirs.make("message-progress-") } };
  const open = () => openOpenClawStateDatabase(options);
  const writeOptions = () => ({ ...options, database: open() });
  return {
    open,
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
    expect(db.prepare("SELECT COUNT(*) AS count FROM outbound_message_progress").get()).toEqual({
      count: 2,
    });
    expect(db.prepare("SELECT COUNT(*) AS count FROM audit_events").get()).toEqual({ count: 0 });
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
    const insert = db.prepare(`
      INSERT INTO outbound_message_progress (
        progress_id, source_id, source_sequence, schema_version, occurred_at,
        action, outcome, actor_type, actor_id, agent_id, run_id, channel,
        conversation_kind, duration_ms
      ) VALUES (?, ?, ?, 1, ?, ?, ?, 'agent', 'main', 'main', 'run-progress',
        'qa-channel', 'direct', 1)
    `);
    db.exec("BEGIN");
    try {
      for (let index = 0; index < 300; index += 1) {
        for (const [stage, action, outcome] of [
          ["queued", "message.outbound.queued", "queued"],
          ["platform", "message.outbound.platform-started", "platform_started"],
        ] as const) {
          insert.run(
            `progress:${index}:${stage}`,
            `source:${index}:${stage}`,
            index * 2 + (stage === "queued" ? 1 : 2),
            occurredAt + index,
            action,
            outcome,
          );
        }
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }

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
    const expiredAt = now - 31 * 24 * 60 * 60_000;
    db.prepare(
      `WITH RECURSIVE numbers(n) AS (
         SELECT 1
         UNION ALL
         SELECT n + 1 FROM numbers WHERE n < ?
       )
       INSERT INTO outbound_message_progress (
         progress_id, source_id, source_sequence, schema_version, occurred_at, action,
         outcome, actor_type, actor_id, agent_id, run_id, channel, conversation_kind
       )
       SELECT 'expired-progress-' || n, 'expired-progress-source-' || n, n, 1, ?,
              'message.outbound.queued', 'queued', 'agent', 'main', 'main',
              'expired-progress-run-' || n, 'qa-channel', 'direct'
       FROM numbers`,
    ).run(OUTBOUND_PROGRESS_PRUNE_BATCH_ROWS_CONTRACT + 1, expiredAt);

    expect(database.prune(now)).toBe(OUTBOUND_PROGRESS_PRUNE_BATCH_ROWS_CONTRACT);
    expect(db.prepare("SELECT COUNT(*) AS count FROM outbound_message_progress").get()).toEqual({
      count: 1,
    });
    expect(database.prune(now)).toBe(1);
    expect(database.prune(now)).toBe(0);
    expect(db.prepare("SELECT COUNT(*) AS count FROM audit_events").get()).toEqual({ count: 1 });
  });
});
