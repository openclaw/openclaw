import * as timers from "node:timers/promises";
import { expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import {
  closeOpenClawAgentDatabasesAsync,
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../runtime-snapshot.js";
import { loadTranscriptEventsFromDatabase } from "./session-accessor.sqlite-read.js";
import { resolveSqliteTranscriptScope } from "./session-accessor.sqlite-scope.js";
import {
  rewriteSqliteTranscriptEventRowsInTransaction,
  updateSqliteTranscriptEventJsonInTransaction,
} from "./session-accessor.sqlite-transcript-rewrite.js";
import { replaceSqliteTranscriptEventsInTransaction } from "./session-accessor.sqlite-transcript-store.js";
import * as transcriptMaintenance from "./session-transcript-index-maintenance.js";
import { readSessionTranscriptIndexStatus } from "./session-transcript-projection-writer.js";
import * as readiness from "./session-transcript-reconcile-readiness.js";
import * as fixtures from "./session-transcript-reconcile.fixtures.test-support.js";
import {
  isSessionTranscriptIndexReconcileRunning,
  reconcileSessionTranscriptIndexes,
  startSessionTranscriptIndexReconcile,
  waitForSessionTranscriptIndexReconcile,
  waitForSessionTranscriptProjection,
} from "./session-transcript-reconcile.js";

vi.mock("node:worker_threads", async () =>
  (await import("./session-transcript-reconcile.test-support.js")).createObservedWorkerThreads(),
);
vi.mock("node:timers/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:timers/promises")>()),
}));

const { observer, tempDirs } = fixtures.useReconcileTestRuntime();

function projection(sessionId: string, otherIds: string[] = []) {
  const fixture = fixtures.reconcileScope(tempDirs.make("openclaw-projection-"), sessionId);
  setRuntimeConfigSnapshot({});
  const scopeFor = (id: string) => ({
    ...fixture.scope,
    sessionId: id,
    sessionKey: `agent:main:${id}`,
  });
  const scopes = [fixture.scope, ...otherIds.map(scopeFor)];
  let release: (() => void) | undefined;
  return {
    ...fixture,
    scopeFor,
    async prepare() {
      for (const scope of scopes) {
        await fixtures.seedTranscript(scope, "seed", "Projection", null);
      }
      await waitForSessionTranscriptIndexReconcile(fixture.options);
      const database = openOpenClawAgentDatabase(fixture.options);
      for (const scope of scopes) {
        fixtures.markRebuild(database.db, scope.sessionId);
      }
      return database;
    },
    async [Symbol.asyncDispose]() {
      release?.();
      observer.onTask = undefined;
      await waitForSessionTranscriptIndexReconcile(fixture.options);
      await fixtures.closeReconcileDatabases();
      clearRuntimeConfigSnapshot();
    },
    hold: (stage: "plan-start" | "plan-finish", target?: string) => {
      const held = fixtures.holdReconcileAck(observer, stage, target);
      release = held.release;
      return held;
    },
  };
}

function observeStatus() {
  const inspected = createDeferred();
  const read = readiness.readSessionTranscriptProjectionStatus;
  const status = vi
    .spyOn(readiness, "readSessionTranscriptProjectionStatus")
    .mockImplementation(async (...args) => {
      const result = await read(...args);
      inspected.resolve();
      return result;
    });
  return { inspected: inspected.promise, [Symbol.dispose]: () => status.mockRestore() };
}

it("observes foreground traversal completion while foreign writes continue", async () => {
  await using fixture = projection("zz-late");
  const { options, scope } = fixture;
  const { db } = await fixture.prepare();
  fixtures.seedScanBacklog(db, scope.sessionKey);
  fixtures.markRebuild(db);
  const foreignCommit = db.prepare(
    "UPDATE session_windows SET updated_at = updated_at + 1 WHERE session_id = 'a-000'",
  );
  let dispatched = false;
  let foreground = false;
  let preflightBatches = 0;
  const drainStatus = transcriptMaintenance.drainTranscriptIndexStatus;
  using _ = vi
    .spyOn(transcriptMaintenance, "drainTranscriptIndexStatus")
    .mockImplementation(async (maintain, previousTraversal) => {
      if (foreground) {
        return drainStatus(maintain, previousTraversal);
      }
      const next = async () => {
        if (!dispatched) {
          if (++preflightBatches > 8) {
            throw new Error("Projection planning waited for foreign writes to stop");
          }
          foreignCommit.run();
        }
        const receipt = await maintain();
        if (!dispatched) {
          foreignCommit.run();
          foreground = true;
          try {
            await expect(readSessionTranscriptIndexStatus(options)).resolves.toBe(true);
          } finally {
            foreground = false;
          }
        }
        return receipt;
      };
      // Return one genuine incomplete batch first; its remaining work must precede planning.
      if (preflightBatches === 0) {
        return next();
      }
      return drainStatus(next, previousTraversal);
    });
  const worklists: string[][] = [];
  observer.onTask = ({ input }) => {
    if (input.mode === "disk") {
      dispatched = true;
      worklists.push([...input.sessionIds]);
    }
  };
  await fixtures.expectReconciled(reconcileSessionTranscriptIndexes(options));
  expect(worklists).toEqual([[scope.sessionId]]);
  expect(fixtures.rows(db, "SELECT needs_rebuild FROM session_transcript_index_state")).toEqual([
    { needs_rebuild: 0 },
  ]);
  observer.onTask = undefined;
});

it.each([
  "waiting-for-publication",
  "publication-cancel",
  "queued-status",
  "during-close",
] as const)(
  "preserves readiness lifetime and cancellation across %s",
  async (boundary) => {
    await using fixture = projection("retired-read");
    const { options, scope, hold } = fixture;
    const database = await fixture.prepare();
    const held = hold("plan-start");
    const resume = held.release;
    startSessionTranscriptIndexReconcile(options);
    await held.paused;
    const retire = async () => {
      const closing = closeOpenClawAgentDatabasesAsync();
      observer.onTask = undefined;
      resume?.();
      await closing;
      await waitForSessionTranscriptIndexReconcile(options);
    };
    if (boundary === "during-close") {
      observer.onTask = undefined;
      const closing = closeOpenClawAgentDatabasesAsync();
      const readinessOptions = { ...options, path: database.path };
      await expect(
        readiness.readSessionTranscriptProjectionStatus(readinessOptions, scope.sessionId),
      ).resolves.toBe(false);
      const controller = new AbortController();
      const reason = new Error("cancel projection status during close");
      controller.abort(reason);
      await expect(
        readiness.readSessionTranscriptProjectionStatus(
          readinessOptions,
          scope.sessionId,
          controller.signal,
        ),
      ).rejects.toMatchObject({ name: "AbortError", cause: reason });
      expect(() => startSessionTranscriptIndexReconcile(options)).not.toThrow();
      let settled = false;
      const waiting = waitForSessionTranscriptProjection(scope).then(() => {
        settled = true;
      });
      await timers.setImmediate();
      expect(settled).toBe(false);
      resume?.();
      await closing;
      await waiting;
    } else if (boundary === "queued-status") {
      const {
        historyLane: { pool: historyPages },
      } = await import("./session-transcript-worker-resources.js");
      const { withSessionHistoryWorkerDatabase } =
        await import("./session-transcript-worker-runtime.js");
      const preparing = createDeferred();
      const releasePreparation = createDeferred();
      const queued = createDeferred();
      const run = historyPages.run.bind(historyPages);
      const capacity = historyPages.getSnapshot().maxWorkers;
      let submissions = 0;
      let enteredCount = 0;
      using _ = vi.spyOn(historyPages, "run").mockImplementation((input, taskOptions) => {
        if (submissions++ >= capacity) {
          const pending = run(input, taskOptions);
          queued.resolve();
          return pending;
        }
        return run(async () => {
          if (++enteredCount === capacity) {
            preparing.resolve();
          }
          await releasePreparation.promise;
          return typeof input === "function" ? await input() : input;
        }, taskOptions);
      });
      const blockers = Array.from({ length: capacity }, () =>
        withSessionHistoryWorkerDatabase(options, (owner) =>
          owner.readProjectionStatus({ env: options.env, sessionId: scope.sessionId }),
        ),
      );
      const controller = new AbortController();
      const reason = new Error("cancel queued projection status");
      let ready: Promise<unknown> | undefined;
      try {
        await awaitGateBeforeSettlement(
          preparing.promise,
          Promise.all(blockers),
          "Projection reads settled before filling the worker pool",
        );
        ready = waitForSessionTranscriptProjection(scope, controller.signal).catch(
          (error: unknown) => error,
        );
        await queued.promise;
        expect(historyPages.getSnapshot()).toMatchObject({
          activeTasks: capacity,
          pendingTasks: capacity + 1,
        });
        controller.abort(reason);
        expect(historyPages.getSnapshot()).toMatchObject({
          activeTasks: capacity,
          pendingTasks: capacity,
        });
        await expect(ready).resolves.toMatchObject({ name: "AbortError", cause: reason });
      } finally {
        releasePreparation.resolve();
        const outcomes = await Promise.allSettled([...blockers, ready]);
        for (const outcome of outcomes.slice(0, capacity)) {
          expect(outcome).toMatchObject({ status: "fulfilled", value: true });
        }
      }
    } else {
      using observed = observeStatus();
      const controller = new AbortController();
      const waiting = waitForSessionTranscriptProjection(scope, controller.signal);
      await observed.inspected;
      if (boundary === "publication-cancel") {
        const reason = new Error("cancel projection publication wait");
        controller.abort(reason);
        await expect(waiting).rejects.toMatchObject({ name: "AbortError", cause: reason });
        expect(isSessionTranscriptIndexReconcileRunning(options)).toBe(true);
      } else {
        const closing = retire();
        await expect(waiting).resolves.toBeUndefined();
        await closing;
      }
    }
  },
  30_000,
);

it("settles pending sessions after background failure without retracting published readiness", async () => {
  await using fixture = projection("ready-first", ["broken-next"]);
  const { options, scope, hold, scopeFor } = fixture;
  const database = await fixture.prepare();
  const broken = scopeFor("broken-next");
  database.db
    .prepare("UPDATE transcript_events SET event_json = '{' WHERE session_id = ? AND seq = 1")
    .run(broken.sessionId);
  const held = hold("plan-finish", scope.sessionId);
  const terminal = createDeferred<"done" | "failed">();
  const observeTask = observer.onTask;
  observer.onTask = (task) => {
    observeTask?.(task);
    task.observeMessage((message) => {
      if (message.type === "done" || message.type === "failed") {
        terminal.resolve(message.type);
      }
    });
  };
  startSessionTranscriptIndexReconcile({ ...options, preferredSessionId: scope.sessionId });
  await held.paused;
  await expect(waitForSessionTranscriptProjection(scope)).resolves.toBeUndefined();
  using observed = observeStatus();
  const waiting = waitForSessionTranscriptProjection(broken);
  const failure = expect(waiting).resolves.toBeUndefined();
  await observed.inspected;
  held.release();
  await expect(terminal.promise).resolves.toBe("failed");
  await failure;
  expect(fixtures.rebuildState(database.db, broken.sessionId)).toEqual({ needs_rebuild: 1 });
  await expect(waitForSessionTranscriptProjection(scope)).resolves.toBeUndefined();
}, 30_000);

it.each(["rewrite", "replacement", "json-update"] as const)(
  "publishes synchronous %s readiness before unrelated reconciliation finishes",
  async (producer) => {
    await using fixture = projection("sync-target", ["unrelated"]);
    const { options, scope, hold, scopeFor } = fixture;
    const database = await fixture.prepare();
    const unrelated = scopeFor("unrelated");
    const events = loadTranscriptEventsFromDatabase(database, scope.sessionId);
    const held = hold("plan-start", unrelated.sessionId);
    startSessionTranscriptIndexReconcile({ ...options, preferredSessionId: unrelated.sessionId });
    await held.paused;
    using observed = observeStatus();
    let settled = false;
    const waiting = waitForSessionTranscriptProjection(scope).then(() => {
      settled = true;
    });
    await observed.inspected;
    await timers.setTimeout(40);
    expect(settled).toBe(false);
    runOpenClawAgentWriteTransaction((current) => {
      if (producer === "replacement") {
        replaceSqliteTranscriptEventsInTransaction(
          current,
          resolveSqliteTranscriptScope(scope),
          events,
        );
      } else if (producer === "json-update") {
        updateSqliteTranscriptEventJsonInTransaction(current, scope.sessionId, [
          { seq: 1, eventJson: JSON.stringify(events[1]!) },
        ]);
      } else {
        const event = events[1]!;
        rewriteSqliteTranscriptEventRowsInTransaction(
          current,
          resolveSqliteTranscriptScope(scope),
          [{ seq: 1, event, expectedEventJson: JSON.stringify(event) }],
        );
      }
    }, options);
    await waiting;
    expect(isSessionTranscriptIndexReconcileRunning(options)).toBe(true);
    expect(fixtures.rebuildState(database.db, unrelated.sessionId)).toEqual({ needs_rebuild: 1 });
  },
  30_000,
);
