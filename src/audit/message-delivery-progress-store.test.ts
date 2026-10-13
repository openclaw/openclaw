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
import type { ExecutionIdentityAdmissionToken } from "./execution-identity-admission.js";
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

function databaseOptions() {
  return { env: { OPENCLAW_STATE_DIR: tempDirs.make("message-progress-") } };
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

function terminalInput(
  overrides: {
    sourceId?: string;
    sourceSequence?: number;
    occurredAt?: number;
    runId?: string;
    executionIdentityToken?: ExecutionIdentityAdmissionToken;
  } = {},
) {
  return {
    sourceId: "queue:payload:0",
    sourceSequence: 3,
    occurredAt: Date.now(),
    kind: "message" as const,
    action: "message.outbound.finished" as const,
    status: "succeeded" as const,
    outcome: "sent" as const,
    actorType: "agent" as const,
    actorId: "main",
    agentId: "main",
    runId: "run-progress",
    direction: "outbound" as const,
    channel: "qa-channel",
    conversationKind: "direct" as const,
    durationMs: 3,
    resultCount: 1,
    accountId: "raw-account",
    conversationId: "raw-conversation",
    messageId: "raw-platform-message",
    targetId: "raw-target",
    ...overrides,
  };
}

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
});

describe("outbound message progress companion", () => {
  it("stays absent through startup, reads, and terminal-only writes at the current schema", () => {
    const database = databaseOptions();
    const opened = openOpenClawStateDatabase(database);
    expect(opened.db.prepare("PRAGMA user_version").get()).toEqual({
      user_version: OPENCLAW_STATE_SCHEMA_VERSION,
    });
    expect(tableExists(opened.db, "outbound_message_progress")).toBe(false);
    expect(tableExists(opened.db, "outbound_message_execution_bindings")).toBe(false);

    expect(
      countOutboundMessageAuditEventsForRunInDatabase(openOpenClawStateDatabase(database).db, {
        runId: "missing",
      }),
    ).toBe(0);
    expect(tableExists(opened.db, "outbound_message_progress")).toBe(false);

    recordAuditEventInDatabase(terminalInput(), {
      ...database,
      database: openOpenClawStateDatabase(database),
    });
    expect(tableExists(opened.db, "outbound_message_progress")).toBe(false);
    expect(tableExists(opened.db, "outbound_message_execution_bindings")).toBe(false);
    expect(
      opened.db
        .prepare("SELECT COUNT(*) AS count FROM audit_events WHERE action != ?")
        .get("message.outbound.finished"),
    ).toEqual({ count: 0 });
  });

  it("ensures idempotently, deduplicates replay, and stores no raw message material", () => {
    const database = databaseOptions();
    const queued = progressInput("message.outbound.queued");
    const first = recordOutboundMessageProgressInDatabase(queued, {
      ...database,
      database: openOpenClawStateDatabase(database),
    });
    closeOpenClawStateDatabaseForTest();
    const recoveredReplay = recordOutboundMessageProgressInDatabase(queued, {
      ...database,
      database: openOpenClawStateDatabase(database),
    });
    recordOutboundMessageProgressInDatabase(progressInput("message.outbound.platform-started"), {
      ...database,
      database: openOpenClawStateDatabase(database),
    });

    expect(first).toMatchObject({ action: "message.outbound.queued", outcome: "queued" });
    expect(recoveredReplay).toBeUndefined();
    const { db } = openOpenClawStateDatabase(database);
    expect(tableExists(db, "outbound_message_progress")).toBe(true);
    expect(db.prepare("SELECT COUNT(*) AS count FROM outbound_message_progress").get()).toEqual({
      count: 2,
    });
    expect(db.prepare("SELECT COUNT(*) AS count FROM audit_events").get()).toEqual({ count: 0 });
    const stored = JSON.stringify(
      db.prepare("SELECT * FROM outbound_message_progress ORDER BY sequence").all(),
    );
    for (const raw of [
      "raw-account",
      "raw-conversation",
      "raw-target",
      "raw-platform-message",
      "message text",
      "https://example.test",
      "callback payload",
      "session-key",
      "secret-value",
    ]) {
      expect(stored).not.toContain(raw);
    }
  });

  it("pages large offsets across bounded owner-stream chunks", () => {
    const database = databaseOptions();
    const occurredAt = Date.now();
    recordOutboundMessageProgressInDatabase(
      progressInput("message.outbound.queued", { occurredAt }),
      { ...database, database: openOpenClawStateDatabase(database) },
    );
    const { db } = openOpenClawStateDatabase(database);
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

    const page = pageOutboundMessageAuditEventsForRunInDatabase(
      openOpenClawStateDatabase(database).db,
      { runId: "run-progress", now: occurredAt, offset: 510, limit: 4 },
    );
    expect(page.entries.map((entry) => entry.event.outcome)).toEqual([
      "queued",
      "platform_started",
      "queued",
      "platform_started",
    ]);
    expect(page.nextCursor).toBeDefined();
    expect(
      pageOutboundMessageAuditEventsForRunInDatabase(openOpenClawStateDatabase(database).db, {
        runId: "run-progress",
        now: occurredAt,
        after: page.nextCursor,
        limit: 2,
      }).entries.map((entry) => entry.event.outcome),
    ).toEqual(["queued", "platform_started"]);
  });

  it("rejects a cursor whose owner row was pruned while preserving the other owner", () => {
    const database = databaseOptions();
    const occurredAt = Date.now();
    recordAuditEventInDatabase(terminalInput({ occurredAt }), {
      ...database,
      database: openOpenClawStateDatabase(database),
    });
    recordOutboundMessageProgressInDatabase(
      progressInput("message.outbound.queued", { occurredAt }),
      { ...database, database: openOpenClawStateDatabase(database) },
    );
    const first = pageOutboundMessageAuditEventsForRunInDatabase(
      openOpenClawStateDatabase(database).db,
      { runId: "run-progress", now: occurredAt, limit: 2 },
    );
    const progress = first.entries.find((entry) => entry.event.outcome === "queued");
    expect(progress).toBeDefined();
    const progressCursor = {
      occurredAt,
      rowId: progress?.rowId ?? 0,
    };
    openOpenClawStateDatabase(database).db.prepare("DELETE FROM outbound_message_progress").run();

    expect(() =>
      pageOutboundMessageAuditEventsForRunInDatabase(openOpenClawStateDatabase(database).db, {
        runId: "run-progress",
        now: occurredAt,
        after: progressCursor,
        limit: 1,
      }),
    ).toThrow("cursor is no longer retained");
    expect(
      pageOutboundMessageAuditEventsForRunInDatabase(openOpenClawStateDatabase(database).db, {
        runId: "run-progress",
        now: occurredAt,
        limit: 10,
      }).entries.map((entry) => entry.event.outcome),
    ).toEqual(["sent"]);
  });

  it("bounds expired progress maintenance while preserving retained terminal rows", () => {
    const database = databaseOptions();
    recordOutboundMessageProgressInDatabase(progressInput("message.outbound.queued"), {
      ...database,
      database: openOpenClawStateDatabase(database),
    });
    const { db } = openOpenClawStateDatabase(database);
    db.exec("DELETE FROM outbound_message_progress");
    const now = Date.now();
    recordAuditEventInDatabase(terminalInput({ occurredAt: now }), {
      ...database,
      database: openOpenClawStateDatabase(database),
    });
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

    expect(
      pruneExpiredOutboundMessageProgressInDatabase({
        database: { ...database, database: openOpenClawStateDatabase(database) },
        now,
      }),
    ).toBe(OUTBOUND_PROGRESS_PRUNE_BATCH_ROWS_CONTRACT);
    expect(db.prepare("SELECT COUNT(*) AS count FROM outbound_message_progress").get()).toEqual({
      count: 1,
    });
    expect(
      pruneExpiredOutboundMessageProgressInDatabase({
        database: { ...database, database: openOpenClawStateDatabase(database) },
        now,
      }),
    ).toBe(1);
    expect(
      pruneExpiredOutboundMessageProgressInDatabase({
        database: { ...database, database: openOpenClawStateDatabase(database) },
        now,
      }),
    ).toBe(0);
    expect(db.prepare("SELECT COUNT(*) AS count FROM audit_events").get()).toEqual({ count: 1 });
  });
});
