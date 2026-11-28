import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanupTempDirs, makeTempDir } from "../../test/helpers/temp-dir.js";
import type { AgentEventPayload } from "../infra/agent-events.js";
import {
  resetDiagnosticEventsForTest,
  type TrustedToolExecutionEvent,
} from "../infra/diagnostic-events.js";
import {
  closeOpenClawStateDatabaseForTest,
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { createAgentEventAuditRecorder } from "./agent-event-audit.js";
import {
  assertAuditOverflowRetention,
  assertAuditRetentionCountDrift,
  assertAuditRunAtomicity,
  assertAuditRunReplay,
  assertAuditRunWarmWrite,
} from "./audit-event-retention.test-support.js";
import {
  listAuditEvents,
  pruneExpiredAuditEventsInDatabase,
  recordAuditEventInDatabase,
} from "./audit-event-store.js";
import type { AuditEventInput, ToolActionAuditEventInput } from "./audit-event-types.js";
import type { AuditEventWriter } from "./audit-event-writer.js";

const tempDirs: string[] = [];
const AUDIT_EVENT_PRUNE_BATCH_ROWS_CONTRACT = 1_024;
const AUDIT_EVENT_RETENTION_MS_CONTRACT = 30 * 24 * 60 * 60_000;
let auditTestRunSequence = 0;
let currentAuditTestRunId = "run-test-0";

function createDatabaseOptions() {
  return { env: { OPENCLAW_STATE_DIR: makeTempDir(tempDirs, "openclaw-audit-") } };
}

function auditInput(overrides: Partial<AuditEventInput> = {}): AuditEventInput {
  const input = {
    sourceSequence: 1,
    occurredAt: Date.now(),
    kind: "agent_run",
    action: "agent.run.started",
    status: "started",
    actorType: "agent",
    actorId: "main",
    agentId: "main",
    sessionKey: "agent:main:main",
    sessionId: "session-1",
    runId: "run-1",
    ...overrides,
  };
  return {
    ...input,
    sourceId:
      overrides.sourceId ??
      `${input.runId}:${input.sourceSequence}:${input.occurredAt}:${input.action}`,
  } as AuditEventInput;
}

function agentEvent(overrides: Partial<AgentEventPayload>): AgentEventPayload {
  return {
    runId: currentAuditTestRunId,
    seq: 1,
    stream: "lifecycle",
    ts: Date.now(),
    data: { phase: "start" },
    sessionKey: "agent:coder:main",
    sessionId: "session-1",
    agentId: "coder",
    ...overrides,
  };
}

function toolEvent(overrides: Partial<TrustedToolExecutionEvent> = {}): TrustedToolExecutionEvent {
  return {
    type: "tool.execution.started",
    seq: 1,
    ts: Date.now(),
    runId: currentAuditTestRunId,
    sessionKey: "agent:coder:main",
    sessionId: "session-1",
    toolName: "exec",
    toolCallId: "call-1",
    ...overrides,
  } as TrustedToolExecutionEvent;
}

function captureAuditWriter(inputs: AuditEventInput[]): AuditEventWriter {
  return {
    ready: Promise.resolve(),
    record: (input) => {
      inputs.push(input);
      return true;
    },
    recordRun: (start, finish) => {
      inputs.push(start, finish);
      return true;
    },
    recordExecutionIdentity: () => true,
    recordExecutionDecision: () => true,
    recordExecutionDecisionWork: () => true,
    stop: async () => {},
  };
}

function projectAgentEventToAudit(event: AgentEventPayload): AuditEventInput | undefined {
  const inputs: AuditEventInput[] = [];
  const recorder = createAgentEventAuditRecorder({
    writer: captureAuditWriter(inputs),
    getConfig: () => ({}),
    terminalSettleMs: 60_000,
  });
  recorder.record(event);
  void recorder.stop();
  return inputs.at(-1);
}

function projectToolExecutionEventToAudit(
  event: TrustedToolExecutionEvent,
): ToolActionAuditEventInput | undefined {
  const inputs: AuditEventInput[] = [];
  const recorder = createAgentEventAuditRecorder({
    writer: captureAuditWriter(inputs),
    getConfig: () => ({}),
  });
  recorder.recordTool(event);
  void recorder.stop();
  return inputs.at(-1) as ToolActionAuditEventInput | undefined;
}

beforeEach(() => {
  currentAuditTestRunId = `run-test-${++auditTestRunSequence}`;
});

afterEach(async () => {
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
  resetDiagnosticEventsForTest();
});

afterAll(() => {
  cleanupTempDirs(tempDirs);
});

describe("audit event persistence", () => {
  it("captures caller filters and the retention clock before the worker wait", async () => {
    const database = createDatabaseOptions();
    const now = Date.now();
    recordAuditEventInDatabase(auditInput({ occurredAt: now, runId: "run-1" }), {
      ...database,
      database: openOpenClawStateDatabase(database),
    });
    const filters = { runId: "run-1" };
    const pending = listAuditEvents({ database, filters, limit: 10 });
    filters.runId = "run-2";
    expect((await pending).events.map((event) => event.runId)).toEqual(["run-1"]);

    const clock = vi
      .spyOn(Date, "now")
      .mockReturnValue(now + AUDIT_EVENT_RETENTION_MS_CONTRACT + 1);
    try {
      expect((await listAuditEvents({ database, limit: 10 })).events).toEqual([]);
    } finally {
      clock.mockRestore();
    }
  });

  it("persists stable ordering, filters, and cursor pagination across reopen", async () => {
    const database = createDatabaseOptions();
    const now = Date.now();
    const oldest = recordAuditEventInDatabase(auditInput({ occurredAt: now, sourceSequence: 1 }), {
      ...database,
      database: openOpenClawStateDatabase(database),
    });
    const middle = recordAuditEventInDatabase(
      auditInput({
        occurredAt: now + 1,
        sourceSequence: 2,
        kind: "tool_action",
        action: "tool.action.started",
        runId: "run-2",
        toolCallId: "call-1",
        toolName: "read",
      }),
      { ...database, database: openOpenClawStateDatabase(database) },
    );
    const newest = recordAuditEventInDatabase(
      auditInput({
        occurredAt: now + 2,
        sourceSequence: 3,
        kind: "tool_action",
        action: "tool.action.finished",
        status: "failed",
        errorCode: "tool_failed",
        runId: "run-2",
        toolCallId: "call-1",
        toolName: "read",
      }),
      { ...database, database: openOpenClawStateDatabase(database) },
    );

    const first = await listAuditEvents({ database, limit: 2 });
    expect(first.events).toEqual([newest, middle]);
    expect(first.events.map((event) => event.sourceSequence)).toEqual([3, 2]);
    expect(first.nextCursor).toBe(first.events[1]?.sequence);

    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    const second = await listAuditEvents({ database, limit: 2, cursor: first.nextCursor });
    expect(second.events).toEqual([oldest]);
    expect(second.events.map((event) => event.sourceSequence)).toEqual([1]);
    expect(second.events[0]?.eventId).toBe(oldest?.eventId);
    expect(second.nextCursor).toBeUndefined();

    const filtered = await listAuditEvents({
      database,
      limit: 10,
      filters: {
        agentId: "main",
        sessionKey: "agent:main:main",
        runId: "run-2",
        kind: "tool_action",
        status: "failed",
        after: now + 2,
        before: now + 2,
      },
    });
    expect(filtered.events).toHaveLength(1);
    expect(filtered.events[0]).toMatchObject({
      action: "tool.action.finished",
      errorCode: "tool_failed",
      redaction: "metadata_only",
    });
  });

  it.each(["source", "event"])("deduplicates replayed %s identities", async (identity) => {
    const database = createDatabaseOptions();
    const input = auditInput();
    const first = recordAuditEventInDatabase(
      input,
      { ...database, database: openOpenClawStateDatabase(database) },
      "replayed-event",
    );
    expect(first?.sequence).toBe(1);
    expect(
      recordAuditEventInDatabase(
        { ...input, ...(identity === "event" ? { sourceId: "another-source" } : {}) },
        { ...database, database: openOpenClawStateDatabase(database) },
        identity === "event" ? "replayed-event" : "another-event",
      ),
    ).toBeUndefined();
    const next = recordAuditEventInDatabase(
      auditInput({ sourceId: "after-replay", sourceSequence: 2 }),
      { ...database, database: openOpenClawStateDatabase(database) },
    );
    expect(next?.sequence).toBe(3);
    expect((await listAuditEvents({ database, limit: 10 })).events).toEqual([next, first]);
  });

  it("writes a warm run pair with one insert and no extra SQL", () => {
    assertAuditRunWarmWrite(openOpenClawStateDatabase(createDatabaseOptions()));
  });

  it("completes whole and partial run-pair replays without duplicating event IDs", () => {
    assertAuditRunReplay(openOpenClawStateDatabase(createDatabaseOptions()));
  });

  it("keeps run pairs atomic and rehydrates the sequence after rollback", () => {
    assertAuditRunAtomicity(openOpenClawStateDatabase(createDatabaseOptions()));
  });

  it("repairs retention count drift once without repeated pruning reads", () => {
    assertAuditRetentionCountDrift(openOpenClawStateDatabase(createDatabaseOptions()));
  });

  it("prunes overflow in one statement and keeps the retained sequence window", () => {
    assertAuditOverflowRetention(openOpenClawStateDatabase(createDatabaseOptions()));
  });

  it("rehydrates the sequence after an enclosing transaction rolls back", async () => {
    const database = createDatabaseOptions();
    const options = { ...database, database: openOpenClawStateDatabase(database) };
    const record = (sourceSequence: number) =>
      recordAuditEventInDatabase(auditInput({ sourceSequence }), options);
    const first = record(1);

    expect(() =>
      runOpenClawStateWriteTransaction(() => {
        expect(record(2)?.sequence).toBe(2);
        throw new Error("rollback enclosing transaction");
      }, options),
    ).toThrow("rollback enclosing transaction");

    const committed = record(3);
    expect(committed?.sequence).toBe(2);
    expect((await listAuditEvents({ database, limit: 10 })).events).toEqual([committed, first]);
  });

  it.each([false, true])("rolls back an unsafe sequence (warmed: %s)", (warmed) => {
    const database = createDatabaseOptions();
    const { db } = openOpenClawStateDatabase(database);
    db.prepare("INSERT INTO sqlite_sequence (name, seq) VALUES ('audit_events', ?)").run(
      BigInt(Number.MAX_SAFE_INTEGER) - (warmed ? 1n : 0n),
    );
    if (warmed) {
      expect(
        recordAuditEventInDatabase(auditInput({ sourceSequence: 1 }), {
          ...database,
          database: openOpenClawStateDatabase(database),
        })?.sequence,
      ).toBe(Number.MAX_SAFE_INTEGER);
    }

    expect(() =>
      recordAuditEventInDatabase(auditInput({ sourceSequence: 2 }), {
        ...database,
        database: openOpenClawStateDatabase(database),
      }),
    ).toThrow("audit event sequence is outside the supported integer range");
    expect(db.prepare("SELECT COUNT(*) AS count FROM audit_events").get()).toEqual({
      count: warmed ? 1 : 0,
    });
  });

  it("returns an expired append only while bounded pruning still retains it", () => {
    const database = createDatabaseOptions();
    const owner = openOpenClawStateDatabase(database);
    const now = Date.now();
    const occurredAt = now - AUDIT_EVENT_RETENTION_MS_CONTRACT - 1_000;
    owner.db
      .prepare(
        `WITH RECURSIVE numbers(n) AS (
         SELECT 1 UNION ALL SELECT n + 1 FROM numbers WHERE n < ?
       )
       INSERT INTO audit_events (
         event_id, source_id, source_sequence, occurred_at, kind, action, status,
         actor_type, actor_id, agent_id, run_id
       )
       SELECT 'old-event-' || n, 'old-source-' || n, n, ?, 'agent_run',
              'agent.run.started', 'started', 'agent', 'main', 'main', 'old-run'
       FROM numbers`,
      )
      .run(AUDIT_EVENT_PRUNE_BATCH_ROWS_CONTRACT, occurredAt);

    const retained = recordAuditEventInDatabase(auditInput({ occurredAt: occurredAt + 1 }), {
      ...database,
      database: owner,
    });
    expect(retained?.occurredAt).toBe(occurredAt + 1);
    expect(
      recordAuditEventInDatabase(auditInput({ occurredAt: occurredAt + 2 }), {
        ...database,
        database: owner,
      }),
    ).toBeUndefined();
    expect(owner.db.prepare("SELECT COUNT(*) AS count FROM audit_events").get()).toEqual({
      count: 0,
    });
  });

  it("tracks earlier inserted expiries and retains events at the exact cutoff", () => {
    const database = createDatabaseOptions();
    const owner = openOpenClawStateDatabase(database);
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    const record = (sourceSequence: number, occurredAt: number) =>
      recordAuditEventInDatabase(auditInput({ sourceSequence, occurredAt }), {
        ...database,
        database: owner,
      });
    const retained = () =>
      owner.db.prepare("SELECT occurred_at FROM audit_events ORDER BY sequence").all();
    try {
      record(1, now + 100);
      record(2, now - 100);
      const cutoff = now - 100 + AUDIT_EVENT_RETENTION_MS_CONTRACT;
      clock.mockReturnValue(cutoff);
      record(3, cutoff);
      expect(retained()).toEqual([
        { occurred_at: now + 100 },
        { occurred_at: now - 100 },
        { occurred_at: cutoff },
      ]);

      clock.mockReturnValue(cutoff + 1);
      record(4, cutoff + 1);
      expect(retained()).toEqual([
        { occurred_at: now + 100 },
        { occurred_at: cutoff },
        { occurred_at: cutoff + 1 },
      ]);

      const nextExpiry = now + 100 + AUDIT_EVENT_RETENTION_MS_CONTRACT + 1;
      clock.mockReturnValue(nextExpiry);
      record(5, nextExpiry);
      expect(retained()).toEqual([
        { occurred_at: cutoff },
        { occurred_at: cutoff + 1 },
        { occurred_at: nextExpiry },
      ]);
    } finally {
      clock.mockRestore();
    }
  });

  it.each(["warm insert", "pruning"] as const)(
    "forgets cached facts when %s fails to commit",
    (mode) => {
      const database = createDatabaseOptions();
      const owner = openOpenClawStateDatabase(database);
      const now = Date.now();
      const clock = vi.spyOn(Date, "now").mockReturnValue(now);
      const record = (sourceSequence: number) =>
        recordAuditEventInDatabase(auditInput({ sourceSequence }), {
          ...database,
          database: owner,
        });
      try {
        const first = record(1);
        owner.db.exec(`
        CREATE TABLE audit_expiry_parent (id INTEGER PRIMARY KEY);
        CREATE TABLE audit_expiry_child (
          parent_id INTEGER NOT NULL,
          FOREIGN KEY (parent_id) REFERENCES audit_expiry_parent(id)
            DEFERRABLE INITIALLY DEFERRED
        );
        CREATE TRIGGER reject_audit_expiry
        AFTER INSERT ON audit_events
        BEGIN
          INSERT INTO audit_expiry_child (parent_id) VALUES (1);
        END;
      `);
        clock.mockReturnValue(
          mode === "pruning" ? now + AUDIT_EVENT_RETENTION_MS_CONTRACT + 1 : now + 1,
        );
        expect(() => record(2)).toThrow(/FOREIGN KEY/u);
        owner.db.exec("DROP TRIGGER reject_audit_expiry");
        const committed = record(3);
        expect(committed).toBeDefined();
        expect(
          owner.db.prepare("SELECT event_id FROM audit_events ORDER BY sequence").all(),
        ).toEqual([
          ...(mode === "warm insert" ? [{ event_id: first?.eventId }] : []),
          { event_id: committed?.eventId },
        ]);
      } finally {
        clock.mockRestore();
      }
    },
  );

  it("excludes and physically prunes records outside the fixed retention window", async () => {
    const database = createDatabaseOptions();
    const occurredAt = Date.now();
    const { db } = openOpenClawStateDatabase(database);
    const insert = db.prepare(
      `INSERT INTO audit_events (
         event_id, source_id, source_sequence, occurred_at, kind, action, status,
         actor_type, actor_id, agent_id, run_id
       ) VALUES (?, ?, ?, ?, 'agent_run', 'agent.run.started', 'started',
                 'agent', 'main', 'main', ?)`,
    );
    for (let index = 0; index < AUDIT_EVENT_PRUNE_BATCH_ROWS_CONTRACT + 1; index += 1) {
      insert.run(`event-${index}`, `source-${index}`, index + 1, occurredAt, `run-${index}`);
    }
    const expiredAt = occurredAt + AUDIT_EVENT_RETENTION_MS_CONTRACT + 1;

    const prune = () =>
      pruneExpiredAuditEventsInDatabase({
        database: { ...database, database: openOpenClawStateDatabase(database) },
        now: expiredAt,
      });
    const rollback = new Error("fixture outer rollback");
    expect(() =>
      runOpenClawStateWriteTransaction(() => {
        expect(prune()).toBe(AUDIT_EVENT_PRUNE_BATCH_ROWS_CONTRACT);
        throw rollback;
      }, database),
    ).toThrow(rollback);
    expect(db.prepare("SELECT COUNT(*) AS count FROM audit_events").get()).toEqual({
      count: AUDIT_EVENT_PRUNE_BATCH_ROWS_CONTRACT + 1,
    });

    expect((await listAuditEvents({ database, limit: 10, now: expiredAt })).events).toEqual([]);
    expect(prune()).toBe(AUDIT_EVENT_PRUNE_BATCH_ROWS_CONTRACT);
    expect(db.prepare("SELECT COUNT(*) AS count FROM audit_events").get()).toEqual({ count: 1 });
    expect(prune()).toBe(1);
    expect(prune()).toBe(0);
  });
});

describe("agent activity audit projection", () => {
  it("does not infer agent identity from a session key", () => {
    const projected = projectAgentEventToAudit(
      agentEvent({ agentId: undefined, sessionKey: "agent:admin:main" }),
    );

    expect(projected).toMatchObject({
      actorType: "system",
      actorId: "unknown",
      agentId: "unknown",
      sessionKey: "agent:admin:main",
    });
  });

  it("keeps an explicit agent id named unknown distinct from missing identity", () => {
    const projected = projectAgentEventToAudit(
      agentEvent({ agentId: "unknown", sessionKey: undefined, sessionId: undefined }),
    );

    expect(projected).toMatchObject({
      actorType: "agent",
      actorId: "unknown",
      agentId: "unknown",
    });
  });

  it("does not share reused run id provenance across recorder instances", () => {
    const runId = "run-reused-across-recorders";
    projectAgentEventToAudit(
      agentEvent({
        runId,
        lifecycleGeneration: "gateway-before-reuse",
        sessionKey: "agent:support:main",
        sessionId: "session-support",
        agentId: "support",
      }),
    );

    const projected = projectAgentEventToAudit(
      agentEvent({
        runId,
        lifecycleGeneration: "gateway-after-reuse",
        sessionKey: undefined,
        sessionId: undefined,
        agentId: undefined,
      }),
    );

    expect(projected).toMatchObject({
      actorType: "system",
      actorId: "unknown",
      agentId: "unknown",
    });
    expect(projected).not.toHaveProperty("sessionKey");
    expect(projected).not.toHaveProperty("sessionId");
  });

  it("does not let tool events inherit remembered lifecycle provenance", async () => {
    const inputs: AuditEventInput[] = [];
    const recorder = createAgentEventAuditRecorder({
      writer: captureAuditWriter(inputs),
      getConfig: () => ({}),
    });
    const runId = "run-tool-no-provenance";
    recorder.record(
      agentEvent({
        runId,
        sessionKey: "agent:support:main",
        sessionId: "session-support",
        agentId: "support",
      }),
    );
    recorder.recordTool(
      toolEvent({
        runId,
        sessionKey: undefined,
        sessionId: undefined,
        agentId: undefined,
      }),
    );
    await recorder.stop();

    const toolInput = inputs.find((input) => input.kind === "tool_action");
    expect(toolInput).toMatchObject({
      actorType: "system",
      actorId: "unknown",
      agentId: "unknown",
    });
    expect(toolInput).not.toHaveProperty("sessionKey");
    expect(toolInput).not.toHaveProperty("sessionId");
  });

  it("omits prompt, arguments, results, and raw errors from run and tool records", () => {
    const secret = "super-secret-payload";
    projectAgentEventToAudit(agentEvent({ data: { phase: "start", prompt: secret }, seq: 1 }));
    const started = projectToolExecutionEventToAudit(toolEvent({ seq: 2, agentId: "coder" }));
    const failed = projectToolExecutionEventToAudit(
      toolEvent({
        type: "tool.execution.error",
        seq: 3,
        agentId: "coder",
        durationMs: 10,
        errorCategory: secret,
        errorCode: secret,
      }),
    );

    expect(started).toMatchObject({
      status: "started",
      agentId: "coder",
      sessionKey: "agent:coder:main",
      toolName: "exec",
    });
    expect(failed).toMatchObject({
      status: "failed",
      errorCode: "tool_failed",
      action: "tool.action.finished",
    });
    expect(JSON.stringify({ started, failed })).not.toContain(secret);
    expect(started).not.toHaveProperty("args");
    expect(failed).not.toHaveProperty("result");
    expect(failed).not.toHaveProperty("error");
  });

  it("redacts provider-controlled tool identities at the durable boundary", () => {
    const secret = `secret-${"x".repeat(600)}`;
    const projected = projectToolExecutionEventToAudit(
      toolEvent({ toolName: secret, toolCallId: secret }),
    );
    const repeated = projectToolExecutionEventToAudit(
      toolEvent({ toolName: secret, toolCallId: secret }),
    );

    expect(projected).toMatchObject({
      toolName: "unknown",
      toolCallId: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
    });
    expect(repeated?.toolCallId).toBe(projected?.toolCallId);
    expect(JSON.stringify(projected)).not.toContain(secret);
  });

  it.each([[{ phase: "error", livenessState: "blocked" }, "blocked", "run_blocked"]] as const)(
    "classifies terminal run metadata %#",
    (data, status, errorCode) => {
      const projected = projectAgentEventToAudit(agentEvent({ seq: 4, data, stream: "lifecycle" }));
      expect(projected).toMatchObject({
        action: "agent.run.finished",
        status,
        errorCode,
      });
      expect(projected).not.toHaveProperty("error");
    },
  );

  it("classifies a trusted blocked tool with explicit attribution", () => {
    const projected = projectToolExecutionEventToAudit(
      toolEvent({
        type: "tool.execution.blocked",
        agentId: "tool-agent",
        sessionKey: "agent:tool-agent:main",
        sessionId: "session-tool-agent",
        deniedReason: "policy",
        reason: "secret detail",
      }),
    );

    expect(projected).toMatchObject({
      status: "blocked",
      actorType: "agent",
      actorId: "tool-agent",
      agentId: "tool-agent",
      sessionKey: "agent:tool-agent:main",
      sessionId: "session-tool-agent",
    });
    expect(projected?.errorCode).toBe("tool_blocked");
    expect(projected).not.toHaveProperty("reason");
  });

  it("does not project pre-invocation schema quarantine as a tool action", () => {
    const projected = projectToolExecutionEventToAudit(
      toolEvent({
        type: "tool.execution.blocked",
        toolCallId: undefined,
        deniedReason: "unsupported_tool_schema",
        reason: "unsupported input schema",
      }),
    );

    expect(projected).toBeUndefined();
  });

  it.each(["cancelled"])(
    "classifies trusted tool error category %s as cancellation",
    (errorCategory) => {
      const projected = projectToolExecutionEventToAudit(
        toolEvent({
          type: "tool.execution.error",
          durationMs: 10,
          errorCategory,
        }),
      );

      expect(projected).toMatchObject({ status: "cancelled", errorCode: "tool_cancelled" });
    },
  );

  it.each([["timed_out", "aborted", "timed_out", "tool_timed_out"]] as const)(
    "projects trusted tool terminal reason %s ahead of error category %s",
    (terminalReason, errorCategory, status, errorCode) => {
      const projected = projectToolExecutionEventToAudit(
        toolEvent({
          type: "tool.execution.error",
          durationMs: 10,
          errorCategory,
          terminalReason,
        }),
      );

      expect(projected).toMatchObject({ status, errorCode });
    },
  );

  it.each(["timed_out"] as const)(
    "keeps an unavailable tool outcome explicitly unknown despite %s provenance",
    (terminalReason) => {
      const projected = projectToolExecutionEventToAudit(
        toolEvent({
          type: "tool.execution.error",
          durationMs: 10,
          errorCategory: "codex_native_tool_outcome_unknown",
          errorCode: "tool_outcome_unknown",
          terminalReason,
        }),
      );

      expect(projected).toMatchObject({
        status: "unknown",
        errorCode: "tool_outcome_unknown",
      });
    },
  );

  it.each([true, false])("settles accepted errors while collection is %s", async (enabled) => {
    const inputs: AuditEventInput[] = [];
    const writer = captureAuditWriter(inputs);
    let collectionEnabled = true;
    const recorder = createAgentEventAuditRecorder({
      writer,
      getConfig: () => ({ logging: { audit: { enabled: collectionEnabled } } }),
    });
    const lifecycleGeneration = "gateway-1";

    recorder.record(agentEvent({ lifecycleGeneration, seq: 1 }));
    recorder.record(
      agentEvent({
        lifecycleGeneration,
        seq: 2,
        data: { phase: "error", error: "request failed" },
      }),
    );
    collectionEnabled = enabled;
    recorder.record(agentEvent({ lifecycleGeneration, seq: 3, data: { phase: "end" } }));
    await recorder.stop();

    expect(inputs.map(({ action, status }) => ({ action, status }))).toEqual([
      { action: "agent.run.started", status: "started" },
      { action: "agent.run.finished", status: "failed" },
    ]);
  });

  it("keeps one start when a retry cancels a pending terminal", async () => {
    const inputs: AuditEventInput[] = [];
    const writer = captureAuditWriter(inputs);
    const recorder = createAgentEventAuditRecorder({
      writer,
      getConfig: () => ({}),
      terminalSettleMs: 60_000,
    });
    const lifecycleGeneration = "gateway-retry";

    recorder.record(agentEvent({ lifecycleGeneration, seq: 1 }));
    recorder.record(agentEvent({ lifecycleGeneration, seq: 2, data: { phase: "error" } }));
    recorder.record(agentEvent({ lifecycleGeneration, seq: 3 }));
    recorder.record(agentEvent({ lifecycleGeneration, seq: 4, data: { phase: "end" } }));
    recorder.record(agentEvent({ lifecycleGeneration, seq: 5 }));
    recorder.record(agentEvent({ lifecycleGeneration, seq: 6, data: { phase: "end" } }));

    expect(inputs.map(({ action, status }) => ({ action, status }))).toEqual([
      { action: "agent.run.started", status: "started" },
      { action: "agent.run.finished", status: "succeeded" },
      { action: "agent.run.started", status: "started" },
      { action: "agent.run.finished", status: "succeeded" },
    ]);
    await recorder.stop();
  });

  it("persists definitive successful terminals immediately in source order", async () => {
    const inputs: AuditEventInput[] = [];
    const writer = captureAuditWriter(inputs);
    const recorder = createAgentEventAuditRecorder({
      writer,
      getConfig: () => ({}),
      terminalSettleMs: 60_000,
    });

    recorder.record(agentEvent({ seq: 1 }));
    recorder.record(agentEvent({ seq: 2, data: { phase: "end" } }));
    recorder.recordTool(
      toolEvent({
        type: "tool.execution.completed",
        seq: 3,
        durationMs: 1,
      }),
    );

    expect(inputs.map(({ action, status }) => ({ action, status }))).toEqual([
      { action: "agent.run.started", status: "started" },
      { action: "agent.run.finished", status: "succeeded" },
      { action: "tool.action.finished", status: "succeeded" },
    ]);
    await recorder.stop();
  });

  it("merges multiple terminal observations through the canonical outcome contract", async () => {
    const inputs: AuditEventInput[] = [];
    const writer = captureAuditWriter(inputs);
    const recorder = createAgentEventAuditRecorder({ writer, getConfig: () => ({}) });

    recorder.record(agentEvent({ seq: 1 }));
    recorder.record(agentEvent({ seq: 2, data: { phase: "error" } }));
    recorder.record(agentEvent({ seq: 3, data: { phase: "end", aborted: true } }));
    await recorder.stop();

    expect(inputs.at(-1)).toMatchObject({
      action: "agent.run.finished",
      status: "cancelled",
      errorCode: "run_cancelled",
    });
  });
});
