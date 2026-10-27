import assert from "node:assert/strict";
import { afterEach, expect, it, vi } from "vitest";
import { cleanupEmbeddedAttemptSessionPhase } from "../agents/embedded-agent-runner/run/attempt-session-settle.js";
import { createEmbeddedAttemptDeferredLifecycleOwner } from "../agents/embedded-agent-runner/run/deferred-lifecycle-owner.js";
import {
  deleteSessionEntryLifecycle,
  loadSessionEntry,
  patchSessionEntryCore,
  replaceSessionEntry,
} from "../config/sessions/session-accessor.js";
import type { SqliteWorkerOperationSettlement } from "../infra/sqlite-worker-operation-settlement.js";
import { createDiagnosticEmbeddedRunOwner } from "../logging/diagnostic-run-activity.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  getOpenClawAgentDatabaseIfOpen,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { runOpenClawAgentWriteAdmission } from "../state/openclaw-agent-write-admission.js";
import {
  type OpenClawTestState,
  withOpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { createSqliteTrajectoryRuntimeSink } from "./runtime-store-writer.js";
import {
  loadSqliteTrajectoryRuntimeEvents,
  loadSqliteTrajectoryRuntimeEventRowsSync,
} from "./runtime-store.sqlite.js";
import { createTrajectoryEvent, trajectoryEventBytes } from "./runtime-store.test-support.js";
import { createTrajectoryRuntimeRecorder } from "./runtime.js";

// Real native writes and admission run unchanged; only delivery of their evidence changes.
const delivery = vi.hoisted(() => ({
  beforeAppend: undefined as (() => Promise<void>) | undefined,
  afterResult: undefined as (() => void) | undefined,
  settlement: undefined as Promise<SqliteWorkerOperationSettlement> | undefined,
  hideCommit: false,
  appendCalls: 0,
}));
vi.mock("../state/openclaw-agent-execution.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../state/openclaw-agent-execution.js")>();
  return {
    ...actual,
    captureOpenClawAgentDatabaseExecution: (
      ...args: Parameters<typeof actual.captureOpenClawAgentDatabaseExecution>
    ): ReturnType<typeof actual.captureOpenClawAgentDatabaseExecution> => {
      const owned = actual.captureOpenClawAgentDatabaseExecution(...args);
      return {
        ...owned,
        get fileIdentity() {
          return owned.fileIdentity;
        },
        runExisting: (source, operation, options) =>
          owned.runExisting(
            {
              ...source,
              createAdmission(binding) {
                const create = source.createAdmission(binding);
                return (retained) => {
                  const settlement = delivery.settlement;
                  const result = create(
                    settlement ? { settled: retained.settled.then(() => settlement) } : retained,
                  );
                  if (delivery.hideCommit) {
                    vi.spyOn(result.admission, "committed", "get").mockReturnValue(undefined);
                  }
                  return result;
                };
              },
            },
            (scope) =>
              operation({
                execute: async (command, commandOptions) => {
                  if (command.type === "trajectory.events.append") {
                    delivery.appendCalls += 1;
                    const before = delivery.beforeAppend;
                    delivery.beforeAppend = undefined;
                    await before?.();
                  }
                  const result = await scope.execute(command, commandOptions);
                  if (command.type === "trajectory.events.append") {
                    const after = delivery.afterResult;
                    delivery.afterResult = undefined;
                    delivery.settlement = undefined;
                    delivery.hideCommit = false;
                    after?.();
                  }
                  return result;
                },
              }),
            options,
          ),
      };
    },
  };
});

const retention = vi.hoisted(() => ({
  beforeRead: undefined as (() => Promise<void>) | undefined,
  accepted: undefined as Promise<void> | undefined,
  reads: 0,
}));
vi.mock("../config/sessions/session-transcript-worker-runtime.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../config/sessions/session-transcript-worker-runtime.js")
    >();
  return {
    ...actual,
    retainSessionHistoryWorkerDatabase: (
      ...args: Parameters<typeof actual.retainSessionHistoryWorkerDatabase>
    ) => {
      const retained = actual.retainSessionHistoryWorkerDatabase(...args);
      return {
        ...retained,
        owner: {
          ...retained.owner,
          readTrajectoryRetention: async (
            ...readArgs: Parameters<typeof retained.owner.readTrajectoryRetention>
          ) => {
            retention.reads += 1;
            await retention.beforeRead?.();
            return retained.owner.readTrajectoryRetention(...readArgs);
          },
        },
      };
    },
  };
});
vi.mock("./runtime-retention.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./runtime-retention.js")>();
  return {
    ...actual,
    scheduleSqliteTrajectoryRuntimeRetention: (
      ...args: Parameters<typeof actual.scheduleSqliteTrajectoryRuntimeRetention>
    ) => {
      const pending = actual.scheduleSqliteTrajectoryRuntimeRetention(...args);
      retention.accepted = pending;
      return pending;
    },
  };
});

afterEach(() => {
  retention.beforeRead = undefined;
  retention.accepted = undefined;
  retention.reads = 0;
  delivery.beforeAppend = undefined;
  delivery.afterResult = undefined;
  delivery.settlement = undefined;
  delivery.hideCommit = false;
  delivery.appendCalls = 0;
  vi.restoreAllMocks();
});

type Target = { agentId: string; sessionId: string; sessionKey: string; storePath: string };

function withTrajectoryState(
  sessionId: string,
  run: (fixture: { state: OpenClawTestState; target: Target }) => Promise<void>,
  initial: { activeWriterRunId?: string } = {},
) {
  return withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const target = {
      agentId: "main",
      sessionId,
      sessionKey: `agent:main:${sessionId}`,
      storePath: state.statePath("agents", "main", "agent.sqlite"),
    };
    await replaceSessionEntry(target, { sessionId, updatedAt: 1, ...initial });
    return run({ state, target });
  });
}

function pauseAppend(error?: Error, hideCommit = false) {
  const committed = createDeferredCore();
  const settlement = createDeferredCore<SqliteWorkerOperationSettlement>();
  delivery.settlement = settlement.promise;
  delivery.hideCommit = hideCommit;
  delivery.afterResult = () => {
    committed.resolve();
    if (error) {
      throw error;
    }
  };
  return { committed, settlement };
}

function observe(result: Promise<void>) {
  return result.then(
    () => ({ ok: true as const }),
    (error: unknown) => ({ ok: false as const, error }),
  );
}

async function createRecorder(
  target: Target,
  options: Pick<
    Parameters<typeof createTrajectoryRuntimeRecorder>[0],
    "maxRuntimeFileBytes" | "assertCommitAllowed"
  > = {},
) {
  const recorder = await createTrajectoryRuntimeRecorder({
    sessionId: target.sessionId,
    sessionKey: target.sessionKey,
    sessionTarget: target,
    ...options,
  });
  assert(recorder);
  return recorder;
}

async function createSink(
  state: OpenClawTestState,
  target: Target,
  maxRuntimeFileBytes = 1024 * 1024,
) {
  const sink = await createSqliteTrajectoryRuntimeSink({
    env: state.env,
    sessionId: target.sessionId,
    sessionTarget: target,
    maxRuntimeFileBytes,
  });
  assert(sink);
  return sink;
}

async function eventTypes(target: Target) {
  return (await loadSqliteTrajectoryRuntimeEvents(target)).map((event) => event.type);
}

it("persists repeated events and retains the worker owner without a main-thread database", async () => {
  await withTrajectoryState("trajectory-duplicates", async ({ target, state }) => {
    const databaseOptions = { agentId: target.agentId, path: target.storePath, env: state.env };
    expect(getOpenClawAgentDatabaseIfOpen(databaseOptions)).toBeUndefined();
    const sink = await createSink(state, target);
    const event = createTrajectoryEvent({ type: "repeated", sessionId: target.sessionId });
    const line = JSON.stringify(event);
    sink.write(event, line);
    sink.write({ ...event }, line);
    expect(sink.describeFlushState()).toBe(
      `pendingRows=2 queuedBytes=${2 * (Buffer.byteLength(line, "utf8") + 1)} activeOperation=sqlite-append`,
    );
    await sink.flush();
    await retention.accepted;
    expect(sink.describeFlushState()).toBeUndefined();
    expect(await loadSqliteTrajectoryRuntimeEvents(target)).toEqual([event, event]);
    expect(getOpenClawAgentDatabaseIfOpen(databaseOptions)).toBeUndefined();
    expect(retention.reads).toBe(1);
    sink.write({ ...event }, line);
    await sink.flush();
    await retention.accepted;
    expect(await loadSqliteTrajectoryRuntimeEvents(target)).toEqual([event, event, event]);
    expect(getOpenClawAgentDatabaseIfOpen(databaseOptions)).toBeUndefined();
    expect(retention.reads).toBe(1);
  });
});

it("keeps a large eight-event turn in one append across writer yields", async () => {
  await withTrajectoryState("trajectory-large-turn", async ({ target, state }) => {
    const sink = await createSink(state, target);
    const events = Array.from({ length: 8 }, (_, index) =>
      createTrajectoryEvent({
        type: index === 7 ? "session.ended" : "context.compiled",
        sessionId: target.sessionId,
        seq: index,
        payloadSize: 54_000,
      }),
    );
    const lines = events.map((event) => JSON.stringify(event));
    for (const [index, event] of events.entries()) {
      sink.write(event, lines[index]!);
      if (index === 5) {
        // Let any early background append settle before the turn's terminal events.
        await runOpenClawAgentWriteAdmission(
          { agentId: target.agentId, path: target.storePath, env: state.env },
          () => {},
        );
      }
    }
    await sink.flush();
    expect(delivery.appendCalls).toBe(1);
    expect(
      (await loadSqliteTrajectoryRuntimeEvents(target)).map((event) => JSON.stringify(event)),
    ).toEqual(lines);
    expect(sink.describeFlushState()).toBeUndefined();
  });
});

it("reuses committed trajectory facts across metadata writes and clears them after lifecycle deletion", async () => {
  await withTrajectoryState("trajectory-window", async ({ target, state }) => {
    const events = ["first", "later", "final"].map((type) =>
      createTrajectoryEvent({ type, sessionId: target.sessionId }),
    );
    const maxRuntimeFileBytes = trajectoryEventBytes(events.slice(0, 2));
    const sink = await createSink(state, target, maxRuntimeFileBytes);
    const flush = async (event: (typeof events)[number]) => {
      sink.write(event, JSON.stringify(event));
      await sink.flush();
      await retention.accepted;
    };
    await flush(events[0]!);
    await flush(events[1]!);
    await patchSessionEntryCore(target, () => ({ updatedAt: 2 }));
    await flush(events[2]!);
    expect(await loadSqliteTrajectoryRuntimeEvents(target)).toEqual(events.slice(1));
    await deleteSessionEntryLifecycle({
      ...target,
      target: { canonicalKey: target.sessionKey, storeKeys: [target.sessionKey] },
      archiveTranscript: false,
      deleteTranscriptWithoutArchive: true,
    });
    await replaceSessionEntry(target, { sessionId: target.sessionId, updatedAt: 3 });
    const replacement = await createSink(state, target, maxRuntimeFileBytes);
    replacement.write(events[0]!, JSON.stringify(events[0]));
    await replacement.flush();
    await retention.accepted;
    expect(loadSqliteTrajectoryRuntimeEventRowsSync(target)).toEqual([
      { event: events[0], seq: 0 },
    ]);
  });
});

it("rolls back the successful attempt's diagnostic prefix with its terminal event and retries once", async () => {
  await withTrajectoryState(
    "trajectory-terminal-batch",
    async ({ target }) => {
      const original = {
        sessionId: target.sessionId,
        updatedAt: 1,
        activeWriterRunId: "trajectory-run",
      };
      const recorder = await createRecorder(target);
      const owner = createEmbeddedAttemptDeferredLifecycleOwner({
        runId: "trajectory-run",
        sessionId: target.sessionId,
        diagnosticOwner: createDiagnosticEmbeddedRunOwner({
          runId: "trajectory-run",
          sessionId: target.sessionId,
        }),
        isCurrent: () => true,
        onRetryWaitCompleted: () => {},
        trajectoryRecorder: recorder,
        clearActiveRun: () => {},
      });
      recorder.recordEvent("model.completed");
      recorder.recordEvent("trace.artifacts");
      owner.recordSessionEnd({ status: "success" });
      await cleanupEmbeddedAttemptSessionPhase({
        attempt: { sessionId: target.sessionId, runId: "trajectory-run" },
        trajectoryRecorder: recorder,
        trajectoryEndRecorded: true,
        deferredLifecycleOwner: owner,
        buildAbortSettlePromise: () => null,
        state: { terminal: { kind: "ok" }, beforeAgentRunBlockedBy: undefined },
        transcriptLifecycle: { beginCleanup: async () => {}, dispose: async () => {} },
      });
      const databaseOptions = { agentId: target.agentId, path: target.storePath };
      const database = await runOpenClawAgentWriteAdmission(databaseOptions, () => {
        const admittedDatabase = openOpenClawAgentDatabase(databaseOptions);
        admittedDatabase.db.exec(`CREATE TRIGGER reject_trajectory_terminal
        BEFORE INSERT ON trajectory_runtime_events
        WHEN NEW.event_json LIKE '%"type":"session.ended"%'
        BEGIN SELECT RAISE(ABORT, 'synthetic terminal append failure'); END`);
        return admittedDatabase;
      });
      try {
        await owner.complete();
        expect(await loadSqliteTrajectoryRuntimeEvents(target)).toEqual([]);
        expect(loadSessionEntry(target)).toMatchObject(original);
        expect(recorder.describeFlushState()).toContain("pendingRows=3");
      } finally {
        await runOpenClawAgentWriteAdmission(databaseOptions, () => {
          database.db.exec("DROP TRIGGER reject_trajectory_terminal");
        });
      }
      await recorder.flush();
      expect(await eventTypes(target)).toEqual([
        "model.completed",
        "trace.artifacts",
        "session.ended",
      ]);
      expect(recorder.describeFlushState()).toBeUndefined();
    },
    { activeWriterRunId: "trajectory-run" },
  );
});

it("settles retention during concurrent appends and worker session patches", async () => {
  await withTrajectoryState("trajectory-during-retention", async ({ target }) => {
    await replaceSessionEntry(
      { ...target, sessionKey: "agent:main:old-trajectory" },
      { sessionId: "old-trajectory", updatedAt: 1 },
    );
    const database = openOpenClawAgentDatabase({
      agentId: target.agentId,
      path: target.storePath,
    });
    database.db
      .prepare(`INSERT INTO trajectory_runtime_events
      (session_id, seq, run_id, event_json, created_at) VALUES (?, 0, 'old-run', ?, 1)`)
      .run("old-trajectory", JSON.stringify({ type: "old" }));
    const recorder = await createRecorder(target);
    const started = createDeferredCore();
    const release = createDeferredCore();
    retention.beforeRead = async () => {
      started.resolve();
      await release.promise;
      await patchSessionEntryCore(target, () => ({ label: `metadata-${retention.reads}` }), {
        workerGuard: {},
      });
    };
    try {
      recorder.recordEvent("first");
      await recorder.flush();
      await started.promise;
      assert(retention.accepted);
      recorder.recordEvent("while-retention-reads");
      await recorder.flush();
      expect(retention.reads).toBe(1);
      expect(await eventTypes(target)).toEqual(["first", "while-retention-reads"]);
    } finally {
      release.resolve();
      await retention.accepted;
    }
    expect(retention.reads).toBe(1);
    expect(
      await loadSqliteTrajectoryRuntimeEvents({ ...target, sessionId: "old-trajectory" }),
    ).toEqual([]);
    const completedReads = retention.reads;
    recorder.recordEvent("same-window");
    await recorder.flush();
    await retention.accepted;
    expect(retention.reads).toBe(completedReads);
    expect(await eventTypes(target)).toEqual(["first", "while-retention-reads", "same-window"]);
  });
});

it.each(["committed", "unknown"] as const)(
  "settles the captured trajectory prefix before another flush after a lost result (%s)",
  async (outcome) => {
    await withTrajectoryState("trajectory-settlement", async ({ target }) => {
      const recorder = await createRecorder(target);
      recorder.recordEvent("seed");
      await recorder.flush();
      await retention.accepted;
      recorder.recordEvent("warm");
      await recorder.flush();
      await retention.accepted;
      const failure = new Error("trajectory result was lost after native completion");
      const { committed, settlement } = pauseAppend(failure, outcome === "unknown");
      recorder.recordEvent("first");
      const first = observe(recorder.flush());
      let next: ReturnType<typeof observe> | undefined;
      try {
        await Promise.race([
          committed.promise,
          first.then(() => {
            throw new Error("Flush ended before the real native append completed");
          }),
        ]);
        expect(recorder.describeFlushState()).toContain("pendingRows=1");
        recorder.recordEvent("later");
        next = observe(recorder.flush());
        settlement.resolve(
          outcome === "committed" ? { kind: "completed" } : { kind: "unknown", error: failure },
        );
        expect(await first).toEqual({ ok: false, error: failure });
        if (outcome === "committed") {
          expect(await next).toEqual({ ok: true });
          expect(recorder.describeFlushState()).toBeUndefined();
          expect(await eventTypes(target)).toEqual(["seed", "warm", "first", "later"]);
        } else {
          expect(await next).toMatchObject({ ok: false, error: { code: "outcome-unknown" } });
          await expect(recorder.flush()).rejects.toMatchObject({ code: "outcome-unknown" });
          expect(recorder.describeFlushState()).toContain("pendingRows=2");
          expect(await eventTypes(target)).toEqual(["seed", "warm", "first"]);
        }
      } finally {
        settlement.resolve({ kind: "completed" });
        await first;
        await next;
      }
    });
  },
);

it("bounds 2,000 queued events while a background append awaits settlement", async () => {
  await withTrajectoryState("trajectory-long-run", async ({ target }) => {
    const maxRuntimeFileBytes = 64 * 1024;
    const recorder = await createRecorder(target, {
      maxRuntimeFileBytes,
    });
    const { committed, settlement } = pauseAppend();
    const recordCalls = (start: number, end: number) => {
      for (let index = start; index < end; index++) {
        recorder.recordEvent("tool.result", { index, text: "synthetic result ".repeat(64) });
      }
      const bytes = Number(recorder.describeFlushState()?.match(/queuedBytes=(\d+)/)?.[1]);
      expect(bytes).toBeLessThanOrEqual(maxRuntimeFileBytes * (start === 0 ? 1 : 2));
    };
    try {
      recordCalls(0, 32);
      // Native persistence starts during the run, before any explicit final flush.
      await committed.promise;
      recordCalls(32, 1_000);
      recordCalls(1_000, 2_000);
    } finally {
      settlement.resolve({ kind: "completed" });
      await recorder.flush();
    }
    expect(recorder.describeFlushState()).toBeUndefined();
    const events = await loadSqliteTrajectoryRuntimeEvents(target);
    expect(events.length).toBeGreaterThan(0);
    expect(events.length).toBeLessThan(64);
    expect(events.map((event) => event.data?.index)).toEqual(
      Array.from({ length: events.length }, (_, index) => 2_000 - events.length + index),
    );
    expect(
      Buffer.byteLength(events.map((event) => JSON.stringify(event)).join("\n")) + 1,
    ).toBeLessThanOrEqual(maxRuntimeFileBytes);
    // Even an event larger than the window must reach SQLite to expire its old rows.
    recorder.recordEvent("oversized", {
      values: Array.from({ length: 10 }, () => "x".repeat(8_000)),
    });
    await recorder.flush();
    expect(await loadSqliteTrajectoryRuntimeEvents(target)).toEqual([]);
  });
});

it.each(["committed", "unknown"] as const)(
  "joins a background append with a lost result before final flushing (%s)",
  async (outcome) => {
    await withTrajectoryState("trajectory-background-settlement", async ({ target }) => {
      const recorder = await createRecorder(target);
      const failure = new Error("background trajectory result lost after native completion");
      const { committed, settlement } = pauseAppend(failure, outcome === "unknown");
      for (let index = 0; index < 32; index++) {
        recorder.recordEvent("before-settlement", { index });
      }
      try {
        await committed.promise;
        recorder.recordEvent("after-settlement");
      } finally {
        settlement.resolve(
          outcome === "committed" ? { kind: "completed" } : { kind: "unknown", error: failure },
        );
      }
      if (outcome === "committed") {
        await recorder.flush();
        expect(recorder.describeFlushState()).toBeUndefined();
      } else {
        await expect(recorder.flush()).rejects.toMatchObject({ code: "outcome-unknown" });
        await expect(recorder.flush()).rejects.toMatchObject({ code: "outcome-unknown" });
      }
      const events = await loadSqliteTrajectoryRuntimeEvents(target);
      expect(events.filter((event) => event.type === "before-settlement")).toHaveLength(32);
      expect(events.filter((event) => event.type === "after-settlement")).toHaveLength(
        outcome === "committed" ? 1 : 0,
      );
    });
  },
);

it.each([3_000, 6_000])(
  "expires durable rows when a %i-character queued prefix is evicted before append",
  async (chars) => {
    await withTrajectoryState("trajectory-evicted-prefix", async ({ target }) => {
      await replaceSessionEntry(target, { sessionId: target.sessionId, updatedAt: 1 });
      let allowCommit = true;
      const recorder = await createRecorder(target, {
        maxRuntimeFileBytes: 4_096,
        assertCommitAllowed: () => {
          if (!allowCommit) {
            throw new Error("synthetic trajectory refusal");
          }
        },
      });
      recorder.recordEvent("durable-prefix", { text: "a".repeat(1_000) });
      await recorder.flush();
      const durableSeq = loadSqliteTrajectoryRuntimeEventRowsSync(target).at(-1)!.seq;
      recorder.recordEvent("queued-prefix", { text: "b".repeat(chars) });
      recorder.recordEvent("newest", { text: "c".repeat(1_500) });
      allowCommit = false;
      await expect(recorder.flush()).rejects.toThrow("synthetic trajectory refusal");
      expect(await eventTypes(target)).toEqual(["durable-prefix"]);
      allowCommit = true;
      await recorder.flush();
      expect(await eventTypes(target)).toEqual(["newest"]);
      expect(
        loadSqliteTrajectoryRuntimeEventRowsSync({ ...target, afterSeq: durableSeq }).map(
          ({ event }) => event.type,
        ),
      ).toEqual(["newest"]);
    });
  },
);

it("keeps later queue evictions after a captured append settles", async () => {
  await withTrajectoryState("trajectory-overlapping-eviction", async ({ target }) => {
    const recorder = await createRecorder(target, { maxRuntimeFileBytes: 4_096 });
    recorder.recordEvent("durable-prefix", { text: "a".repeat(1_000) });
    await recorder.flush();
    recorder.recordEvent("evicted-before", { text: "b".repeat(3_000) });
    recorder.recordEvent("first-committed", { text: "c".repeat(1_500) });
    const { committed, settlement } = pauseAppend();
    const first = recorder.flush();
    try {
      await committed.promise;
      recorder.recordEvent("evicted-during", { text: "d".repeat(3_000) });
      recorder.recordEvent("newest", { text: "e".repeat(1_500) });
    } finally {
      settlement.resolve({ kind: "completed" });
      await first;
    }
    await recorder.flush();
    expect(await eventTypes(target)).toEqual(["newest"]);
  });
});

it.each(["committed", "refused"] as const)(
  "keeps the newest two rows when C arrives during an A/B append (%s)",
  async (outcome) => {
    await withTrajectoryState("trajectory-abc", async ({ target }) => {
      const recorder = await createRecorder(target, { maxRuntimeFileBytes: 4_096 });
      recorder.recordEvent("A", { text: "a".repeat(1_500) });
      recorder.recordEvent("B", { text: "b".repeat(1_500) });
      const admitted = createDeferredCore();
      const release = createDeferredCore();
      const settlement = createDeferredCore<SqliteWorkerOperationSettlement>();
      const failure = new Error("synthetic pre-transaction refusal");
      if (outcome === "committed") {
        delivery.settlement = settlement.promise;
        delivery.afterResult = () => admitted.resolve();
      } else {
        delivery.beforeAppend = async () => {
          admitted.resolve();
          await release.promise;
          throw failure;
        };
      }
      const first = observe(recorder.flush());
      try {
        await admitted.promise;
        recorder.recordEvent("C", { text: "c".repeat(1_500) });
      } finally {
        release.resolve();
        settlement.resolve({ kind: "completed" });
      }
      expect(await first).toEqual(
        outcome === "committed" ? { ok: true } : { ok: false, error: failure },
      );
      await recorder.flush();
      expect(await eventTypes(target)).toEqual(["B", "C"]);
    });
  },
);
