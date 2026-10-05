import assert from "node:assert/strict";
import { afterEach, expect, it, vi } from "vitest";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import type { SqliteWorkerOperationSettlement } from "../infra/sqlite-worker-operation-settlement.js";
import { createDeferredCore } from "../shared/deferred.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  loadSqliteTrajectoryRuntimeEvents,
  loadSqliteTrajectoryRuntimeEventRowsSync,
} from "./runtime-store.sqlite.js";
import { createTrajectoryRuntimeRecorder } from "./runtime.js";

// Real native writes and admission run unchanged; only delivery of their evidence changes.
const delivery = vi.hoisted(() => ({
  beforeAppend: undefined as (() => Promise<void>) | undefined,
  afterResult: undefined as (() => void) | undefined,
  settlement: undefined as Promise<SqliteWorkerOperationSettlement> | undefined,
  hideCommit: false,
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
vi.mock("../infra/sqlite-readonly-worker.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../infra/sqlite-readonly-worker.js")>();
  return {
    ...actual,
    runSqliteReadOnlyOperation: async (
      ...args: Parameters<typeof actual.runSqliteReadOnlyOperation>
    ) => {
      if (args[1].type === "trajectoryRetention.read") {
        retention.reads += 1;
        await retention.beforeRead?.();
      }
      return actual.runSqliteReadOnlyOperation(...args);
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
  vi.restoreAllMocks();
});

it("settles retention despite another append while its coalesced read is pending", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const target = {
      agentId: "main",
      sessionId: "trajectory-during-retention",
      sessionKey: "agent:main:trajectory-during-retention",
      storePath: state.statePath("agents", "main", "agent.sqlite"),
    };
    await replaceSessionEntry(target, { sessionId: target.sessionId, updatedAt: 1 });
    await replaceSessionEntry(
      { ...target, sessionKey: "agent:main:old-trajectory" },
      { sessionId: "old-trajectory", updatedAt: 1 },
    );
    const database = openOpenClawAgentDatabase({ agentId: target.agentId, path: target.storePath });
    database.db
      .prepare(`INSERT INTO trajectory_runtime_events
      (session_id, seq, run_id, event_json, created_at) VALUES (?, 0, 'old-run', ?, 1)`)
      .run("old-trajectory", JSON.stringify({ type: "old" }));
    const recorder = await createTrajectoryRuntimeRecorder({
      sessionId: target.sessionId,
      sessionKey: target.sessionKey,
      sessionTarget: target,
    });
    assert(recorder);
    const started = createDeferredCore();
    const release = createDeferredCore();
    retention.beforeRead = async () => {
      started.resolve();
      await release.promise;
    };
    try {
      recorder.recordEvent("first");
      await recorder.flush();
      await started.promise;
      assert(retention.accepted);
      recorder.recordEvent("while-retention-reads");
      await recorder.flush();
      expect(retention.reads).toBe(1);
      expect((await loadSqliteTrajectoryRuntimeEvents(target)).map((event) => event.type)).toEqual([
        "first",
        "while-retention-reads",
      ]);
    } finally {
      release.resolve();
      await retention.accepted;
    }
    expect(
      await loadSqliteTrajectoryRuntimeEvents({ ...target, sessionId: "old-trajectory" }),
    ).toEqual([]);
    const completedReads = retention.reads;
    recorder.recordEvent("same-window");
    await recorder.flush();
    await retention.accepted;
    expect(retention.reads).toBe(completedReads);
    expect((await loadSqliteTrajectoryRuntimeEvents(target)).map((event) => event.type)).toEqual([
      "first",
      "while-retention-reads",
      "same-window",
    ]);
  });
});

it.each(["committed", "unknown"] as const)(
  "settles the captured trajectory prefix before another flush after a lost result (%s)",
  async (outcome) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const target = {
        agentId: "main",
        sessionId: "trajectory-settlement",
        sessionKey: "agent:main:trajectory-settlement",
        storePath: state.statePath("agents", "main", "agent.sqlite"),
      };
      await replaceSessionEntry(target, { sessionId: target.sessionId, updatedAt: 1 });
      const recorder = await createTrajectoryRuntimeRecorder({
        sessionId: target.sessionId,
        sessionKey: target.sessionKey,
        sessionTarget: target,
      });
      assert(recorder);
      const committed = createDeferredCore();
      const settlement = createDeferredCore<SqliteWorkerOperationSettlement>();
      const failure = new Error("trajectory result was lost after native completion");
      delivery.settlement = settlement.promise;
      delivery.hideCommit = outcome === "unknown";
      delivery.afterResult = () => {
        committed.resolve();
        throw failure;
      };
      recorder.recordEvent("first");
      const observe = (result: Promise<void>) =>
        result.then(
          () => ({ ok: true as const }),
          (error: unknown) => ({ ok: false as const, error }),
        );
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
          expect(
            (await loadSqliteTrajectoryRuntimeEvents(target)).map((event) => event.type),
          ).toEqual(["first", "later"]);
        } else {
          expect(await next).toMatchObject({ ok: false, error: { code: "outcome-unknown" } });
          await expect(recorder.flush()).rejects.toMatchObject({ code: "outcome-unknown" });
          expect(recorder.describeFlushState()).toContain("pendingRows=2");
          expect(
            (await loadSqliteTrajectoryRuntimeEvents(target)).map((event) => event.type),
          ).toEqual(["first"]);
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
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const target = {
      agentId: "main",
      sessionId: "trajectory-long-run",
      sessionKey: "agent:main:trajectory-long-run",
      storePath: state.statePath("agents", "main", "agent.sqlite"),
    };
    await replaceSessionEntry(target, { sessionId: target.sessionId, updatedAt: 1 });
    const maxRuntimeFileBytes = 64 * 1024;
    const recorder = await createTrajectoryRuntimeRecorder({
      sessionId: target.sessionId,
      sessionKey: target.sessionKey,
      sessionTarget: target,
      maxRuntimeFileBytes,
    });
    assert(recorder);
    const committed = createDeferredCore();
    const settlement = createDeferredCore<SqliteWorkerOperationSettlement>();
    delivery.settlement = settlement.promise;
    delivery.afterResult = () => committed.resolve();
    const recordCalls = (start: number, end: number) => {
      for (let index = start; index < end; index++) {
        recorder.recordEvent("tool.result", { index, text: "synthetic result ".repeat(64) });
      }
      const bytes = Number(recorder.describeFlushState()?.match(/queuedBytes=(\d+)/)?.[1]);
      expect(bytes).toBeLessThanOrEqual(maxRuntimeFileBytes * (start === 0 ? 1 : 2));
    };
    try {
      recordCalls(0, 1_000);
      // Native persistence starts during the run, before any explicit final flush.
      await committed.promise;
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
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const target = {
        agentId: "main",
        sessionId: "trajectory-background-settlement",
        sessionKey: "agent:main:trajectory-background-settlement",
        storePath: state.statePath("agents", "main", "agent.sqlite"),
      };
      await replaceSessionEntry(target, { sessionId: target.sessionId, updatedAt: 1 });
      const recorder = await createTrajectoryRuntimeRecorder({
        sessionId: target.sessionId,
        sessionKey: target.sessionKey,
        sessionTarget: target,
      });
      assert(recorder);
      const committed = createDeferredCore();
      const settlement = createDeferredCore<SqliteWorkerOperationSettlement>();
      const failure = new Error("background trajectory result lost after native completion");
      delivery.settlement = settlement.promise;
      delivery.hideCommit = outcome === "unknown";
      delivery.afterResult = () => {
        committed.resolve();
        throw failure;
      };
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
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const target = {
        agentId: "main",
        sessionId: "trajectory-evicted-prefix",
        sessionKey: "agent:main:trajectory-evicted-prefix",
        storePath: state.statePath("agents", "main", "agent.sqlite"),
      };
      await replaceSessionEntry(target, { sessionId: target.sessionId, updatedAt: 1 });
      let allowCommit = true;
      const recorder = await createTrajectoryRuntimeRecorder({
        sessionId: target.sessionId,
        sessionKey: target.sessionKey,
        sessionTarget: target,
        maxRuntimeFileBytes: 4_096,
        assertCommitAllowed: () => {
          if (!allowCommit) {
            throw new Error("synthetic trajectory refusal");
          }
        },
      });
      assert(recorder);
      recorder.recordEvent("durable-prefix", { text: "a".repeat(1_000) });
      await recorder.flush();
      const durableSeq = loadSqliteTrajectoryRuntimeEventRowsSync(target).at(-1)!.seq;
      recorder.recordEvent("queued-prefix", { text: "b".repeat(chars) });
      recorder.recordEvent("newest", { text: "c".repeat(1_500) });
      allowCommit = false;
      await expect(recorder.flush()).rejects.toThrow("synthetic trajectory refusal");
      expect((await loadSqliteTrajectoryRuntimeEvents(target)).map((event) => event.type)).toEqual([
        "durable-prefix",
      ]);
      allowCommit = true;
      await recorder.flush();
      expect((await loadSqliteTrajectoryRuntimeEvents(target)).map((event) => event.type)).toEqual([
        "newest",
      ]);
      expect(
        loadSqliteTrajectoryRuntimeEventRowsSync({ ...target, afterSeq: durableSeq }).map(
          ({ event }) => event.type,
        ),
      ).toEqual(["newest"]);
    });
  },
);

it("keeps later queue evictions after a captured append settles", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const target = {
      agentId: "main",
      sessionId: "trajectory-overlapping-eviction",
      sessionKey: "agent:main:trajectory-overlapping-eviction",
      storePath: state.statePath("agents", "main", "agent.sqlite"),
    };
    await replaceSessionEntry(target, { sessionId: target.sessionId, updatedAt: 1 });
    const recorder = await createTrajectoryRuntimeRecorder({
      sessionId: target.sessionId,
      sessionKey: target.sessionKey,
      sessionTarget: target,
      maxRuntimeFileBytes: 4_096,
    });
    assert(recorder);
    recorder.recordEvent("durable-prefix", { text: "a".repeat(1_000) });
    await recorder.flush();
    recorder.recordEvent("evicted-before", { text: "b".repeat(3_000) });
    recorder.recordEvent("first-committed", { text: "c".repeat(1_500) });
    const committed = createDeferredCore();
    const settlement = createDeferredCore<SqliteWorkerOperationSettlement>();
    delivery.settlement = settlement.promise;
    delivery.afterResult = () => committed.resolve();
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
    expect((await loadSqliteTrajectoryRuntimeEvents(target)).map((event) => event.type)).toEqual([
      "newest",
    ]);
  });
});

it.each(["committed", "refused"] as const)(
  "keeps the newest two rows when C arrives during an A/B append (%s)",
  async (outcome) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const target = {
        agentId: "main",
        sessionId: "trajectory-abc",
        sessionKey: "agent:main:trajectory-abc",
        storePath: state.statePath("agents", "main", "agent.sqlite"),
      };
      await replaceSessionEntry(target, { sessionId: target.sessionId, updatedAt: 1 });
      const recorder = await createTrajectoryRuntimeRecorder({
        sessionId: target.sessionId,
        sessionKey: target.sessionKey,
        sessionTarget: target,
        maxRuntimeFileBytes: 4_096,
      });
      assert(recorder);
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
      const first = recorder.flush().then(
        () => ({ ok: true as const }),
        (error: unknown) => ({ ok: false as const, error }),
      );
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
      expect((await loadSqliteTrajectoryRuntimeEvents(target)).map((event) => event.type)).toEqual([
        "B",
        "C",
      ]);
    });
  },
);
