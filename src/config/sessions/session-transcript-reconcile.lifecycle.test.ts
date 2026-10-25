import path from "node:path";
import * as timers from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { SQLITE_IDLE_HANDLE_TTL_MS } from "../../infra/sqlite-handle-lifecycle.js";
import * as admission from "../../infra/sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe as workerProbe } from "../../infra/sqlite-worker-owner-probe.test-support.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import { assertNoOpenClawAgentDatabaseLeases } from "../../state/openclaw-agent-db-lease.js";
import { closeCachedOpenClawAgentDatabase } from "../../state/openclaw-agent-db-lifecycle.js";
import {
  closeOpenClawAgentDatabaseByPath,
  closeOpenClawAgentDatabaseByPathAsync as closeDatabase,
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  isOpenClawAgentDatabaseOpen,
  openOpenClawAgentDatabase as openDatabase,
  resolveOpenClawAgentSqlitePath as databasePathFor,
  type OpenClawAgentDatabaseOptions,
} from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseByPathAsync } from "../../state/openclaw-state-db-cache.js";
import {
  closeOpenClawStateDatabaseForTest,
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../runtime-snapshot.js";
import { getSessionTranscriptReconcileWorkerPoolSnapshot as poolSnapshot } from "./session-transcript-reconcile-pool.js";
import * as reconcilePool from "./session-transcript-reconcile-pool.js";
import {
  holdReconcileAck,
  markRebuild as markDirty,
  observeCanonicalWriterLeases,
  projectionMessages,
  readAgentDatabaseLeaseIds,
  rebuildState,
  seedTranscript as seed,
} from "./session-transcript-reconcile.fixtures.test-support.js";
import {
  isSessionTranscriptIndexReconcileRunning as isReconciling,
  reconcileSessionTranscriptIndexes as reconcile,
  startSessionTranscriptIndexReconcile as startReconcile,
  waitForSessionTranscriptIndexReconcile as waitForReconcile,
  waitForSessionTranscriptIndexReconcilesInStateDir as drainStateDirectory,
  waitForSessionTranscriptProjection as waitForProjection,
} from "./session-transcript-reconcile.js";
import { useReconcileWorkerObserver } from "./session-transcript-reconcile.test-support.js";
import type { SessionTranscriptReconcileWorkerMessage } from "./session-transcript-reconcile.worker.js";

vi.mock("node:worker_threads", async () =>
  (await import("./session-transcript-reconcile.test-support.js")).createObservedWorkerThreads(),
);

vi.mock("node:timers/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:timers/promises")>()),
}));

const observer = useReconcileWorkerObserver();

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

beforeEach(() => setRuntimeConfigSnapshot({}));
afterEach(() => clearRuntimeConfigSnapshot());

async function closeDatabases() {
  await closeOpenClawAgentDatabasesAsync();
  closeOpenClawAgentDatabasesForTest();
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
}

async function withFakeClockState(label: string, run: () => Promise<void>) {
  const stateDir = tempDirs.make(label);
  await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
    setRuntimeConfigSnapshot({});
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      await run();
    } finally {
      try {
        await closeDatabases();
      } finally {
        vi.useRealTimers();
      }
    }
  });
}

function scopeFor(sessionId: string, options: OpenClawAgentDatabaseOptions = { agentId: "main" }) {
  return {
    ...options,
    agentId: options.agentId ?? "main",
    sessionId,
    sessionKey: `agent:${options.agentId ?? "main"}:${sessionId}`,
  };
}

function expectLeases(databasePath: string, ...expected: Array<string | undefined>) {
  expect(readAgentDatabaseLeaseIds(databasePath)).toEqual(
    expected.toSorted((a, b) => String(a).localeCompare(String(b))),
  );
}

const settledOutcome = <T>(operation: Promise<T>) =>
  operation.then(
    (value) => ({ status: "fulfilled" as const, value }),
    (error: unknown) => ({ status: "rejected" as const, error }),
  );

type TerminalType = Extract<
  SessionTranscriptReconcileWorkerMessage,
  { type: "done" | "failed" }
>["type"];

function countAgentDatabaseLeases(pathname: string, env?: NodeJS.ProcessEnv): number {
  // SAFETY: SQLite COUNT(*) always returns one row with the numeric alias requested here.
  const row = openOpenClawStateDatabase({ env })
    .db.prepare(
      `SELECT COUNT(*) AS count
       FROM agent_database_leases
       WHERE owner_pid = ? AND path = ?`,
    )
    .get(process.pid, pathname) as { count: number };
  return row.count;
}

function createCleanupFenceProbe() {
  const stateDatabase = openOpenClawStateDatabase();
  let lockHeld = false;
  let plannerLeaseId: string | undefined;
  const planStarted = createDeferred();
  const terminal = createDeferred<TerminalType>();
  observer.onTask = ({ input, observeMessage }) => {
    if (input.mode === "disk") {
      plannerLeaseId = input.leaseId;
    }
    // This listener runs before the reconciler's listener. Holding
    // the state writer after plan-start fences the worker's lease release.
    observeMessage((message: SessionTranscriptReconcileWorkerMessage) => {
      if (message.type === "plan-start" && !lockHeld) {
        stateDatabase.db.exec("BEGIN IMMEDIATE;");
        lockHeld = true;
        planStarted.resolve();
      }
      if (message.type === "done" || message.type === "failed") {
        terminal.resolve(message.type);
      }
    });
  };

  return {
    planStarted: planStarted.promise,
    plannerLeaseId: () => plannerLeaseId,
    release(): void {
      if (!lockHeld) {
        return;
      }
      stateDatabase.db.exec("ROLLBACK;");
      lockHeld = false;
    },
    terminal: terminal.promise,
  };
}

function readProjectedTranscript(database: ReturnType<typeof openDatabase>, sessionId: string) {
  return database.db
    .prepare(`SELECT active.active_position, events.event_json
    FROM session_transcript_active_events active JOIN transcript_events events
      ON events.session_id = active.session_id AND events.seq = active.event_seq
    WHERE active.session_id = ? ORDER BY active.active_position`)
    .all(sessionId);
}

async function waitForCurrentProjection(databasePath: string, sessionId: string): Promise<void> {
  const database = openDatabase({ agentId: "main", path: databasePath });
  await vi.waitFor(
    () => {
      expect(rebuildState(database.db, sessionId)).toEqual({ needs_rebuild: 0 });
    },
    { interval: 10, timeout: 5_000 },
  );
}

async function expectIdleRetirement(database: ReturnType<typeof openDatabase>) {
  expect(database.db.isOpen).toBe(true);
  await vi.advanceTimersByTimeAsync(SQLITE_IDLE_HANDLE_TTL_MS);
  expect(database.db.isOpen).toBe(false);
  await vi.waitFor(() => expect(countAgentDatabaseLeases(database.path)).toBe(0));
}

describe("session transcript reconcile worker lifecycle", () => {
  it("queues dirty agents behind one reusable fleet worker and releases each database lease", async () => {
    const stateDir = tempDirs.make("openclaw-reconcile-fleet-");
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    const agents = Array.from({ length: 8 }, (_, index) => ({ agentId: `fleet-${index}`, env }));
    const sessionId = "fleet-session";
    const hostLeases: string[] = [];
    const facts = vi.fn();
    const transactionStates: Array<boolean | undefined> = [];
    let stopFacts: (() => void) | undefined;
    let stopChanges: (() => void) | undefined;
    try {
      for (const options of agents) {
        await seed(
          { ...options, sessionId, sessionKey: `agent:${options.agentId}:fleet` },
          options.agentId,
          options.agentId,
          null,
        );
        await waitForReconcile(options);
        // Leave only the native fixture lease before queuing cold publication workers.
        await closeDatabase(databasePathFor(options));
        markDirty(openDatabase(options).db);
      }
      for (const options of agents) {
        const leases = readAgentDatabaseLeaseIds(databasePathFor(options), env);
        expect(leases).toHaveLength(1);
        hostLeases.push(...leases);
      }
      const before = poolSnapshot();
      const databases = new Map(
        agents.map((options) => {
          const database = openDatabase(options);
          return [database.path, database] as const;
        }),
      );
      stopFacts = sessionChanges.subscribeFacts(facts);
      stopChanges = sessionChanges.subscribe((change) => {
        if ("sessionKey" in change && change.scope === "transcript") {
          transactionStates.push(databases.get(change.storePath)?.db.isTransaction);
        }
      });
      const fence = holdReconcileAck(observer, "plan-finish", sessionId);
      for (const options of agents) {
        startReconcile(options);
      }
      const completion = Promise.all(agents.map((agent) => waitForReconcile(agent)));
      try {
        await fence.paused;
        expect(poolSnapshot()).toMatchObject({
          maxWorkers: 1,
          workers: 1,
          workersCreated: before.workersCreated + 1,
          activeTasks: 1,
        });
      } finally {
        fence.release();
        await completion;
      }
      expect(poolSnapshot()).toMatchObject({
        maxWorkers: 1,
        workers: 1,
        workersCreated: before.workersCreated + 1,
        activeTasks: 0,
        pendingTasks: 0,
      });
      const retainedLeases: string[] = [];
      for (const options of agents) {
        const database = openDatabase(options);
        expect(projectionMessages(database.db)).toEqual([
          { message_id: options.agentId, text: options.agentId },
        ]);
        expect(rebuildState(database.db, sessionId)).toEqual({ needs_rebuild: 0 });
        expect(facts).toHaveBeenCalledWith({
          storePath: database.path,
          sessionKey: `agent:${options.agentId}:fleet`,
          scope: "transcript",
          facts: { kind: "unchanged" },
        });
        const leases = readAgentDatabaseLeaseIds(database.path, env);
        const plannerLeaseId = fence.plannerLeases.get(database.path);
        expect(plannerLeaseId).toMatch(/^[a-f0-9-]+$/u);
        expect(leases).not.toContain(plannerLeaseId);
        retainedLeases.push(...leases);
      }
      expect(retainedLeases.filter((lease) => hostLeases.includes(lease)).toSorted()).toEqual(
        hostLeases.toSorted(),
      );
      expect(transactionStates).toEqual(agents.map(() => false));
    } finally {
      stopFacts?.();
      stopChanges?.();
      await drainStateDirectory(stateDir);
      await closeDatabases();
    }
  }, 30_000);

  it("drains later fixture owners without waiting for an unrelated state directory", async () => {
    const root = tempDirs.make("openclaw-reconcile-scope-");
    const stateDir = path.join(root, "state");
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    const first = { agentId: "main", env };
    const later = { agentId: "later", env };
    const unrelated = {
      agentId: "main",
      env: { ...env, OPENCLAW_STATE_DIR: `${stateDir}-unrelated` },
    };
    const runOperation = reconcilePool.runSessionTranscriptReconcileOperation;
    const operationSpy = vi.spyOn(reconcilePool, "runSessionTranscriptReconcileOperation");
    const startDeferred = (options: OpenClawAgentDatabaseOptions) => {
      const release = createDeferred();
      operationSpy.mockImplementationOnce((run, owner) =>
        runOperation(async (operation) => {
          await release.promise;
          return run(operation);
        }, owner),
      );
      startReconcile(options);
      return release;
    };
    const releaseFirst = startDeferred(first);
    const releaseUnrelated = startDeferred(unrelated);
    let settled = false;
    const scopedWait = drainStateDirectory(stateDir).then(() => {
      settled = true;
    });
    // This owner did not exist in the waiter's initial snapshot, and no owner
    // has opened its database yet: scope must come from the registered keys.
    const releaseLater = startDeferred(later);
    try {
      releaseFirst.resolve();
      await waitForReconcile(first);
      await timers.setImmediate();
      expect(settled).toBe(false);
      expect(isReconciling(later)).toBe(true);

      releaseLater.resolve();
      await waitForReconcile(later);
      // A checkpoint makes a wrongly global wait fail here, while finally can
      // still release the unrelated owner instead of deadlocking the test.
      await timers.setImmediate();
      expect(settled).toBe(true);
      expect(isReconciling(unrelated)).toBe(true);
      expect(isOpenClawAgentDatabaseOpen(databasePathFor(unrelated))).toBe(false);
    } finally {
      operationSpy.mockRestore();
      releaseFirst.resolve();
      releaseLater.resolve();
      releaseUnrelated.resolve();
      await Promise.all([
        scopedWait,
        ...[first, later, unrelated].map((agent) => waitForReconcile(agent)),
      ]);
      for (const options of [first, later, unrelated]) {
        await closeDatabase(databasePathFor(options));
      }
      for (const options of [first, unrelated]) {
        await closeOpenClawStateDatabaseByPathAsync(resolveOpenClawStateSqlitePath(options.env));
      }
    }
  });

  it("awaits pending-pass backoff while coalescing writes and keeping ready sessions available", async () => {
    const stateDir = tempDirs.make("openclaw-reconcile-backoff-");
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    const databaseOptions = { agentId: "main", env };
    const scope = scopeFor("reconcile-backoff", databaseOptions);
    const readyScope = { ...scope, sessionId: "ready-sibling", sessionKey: "agent:main:ready" };
    const paused = createDeferred();
    const resume = createDeferred();
    let injectPending = true;
    let injectedPending = 0;
    const realSleep = timers.setTimeout;
    const sleepSpy = vi.spyOn(timers, "setTimeout");
    try {
      for (const target of [scope, readyScope]) {
        await seed(target, `${target.sessionId}-seed`, "seed");
      }
      await waitForReconcile(databaseOptions);
      await closeDatabase(databasePathFor(databaseOptions));
      const database = openDatabase(databaseOptions);
      // Each active pass additionally retains the canonical publication actor until idle retirement.
      const baselineLeaseCount = countAgentDatabaseLeases(database.path, env);

      markDirty(database.db, scope.sessionId);
      observer.onTask = ({ observeMessage }) => {
        observeMessage((message: SessionTranscriptReconcileWorkerMessage) => {
          if (message.type !== "done" || !injectPending || injectedPending >= 6) {
            return;
          }
          markDirty(database.db, scope.sessionId);
          injectedPending += 1;
          startReconcile({ ...databaseOptions, preferredSessionId: scope.sessionId });
        });
      };
      sleepSpy.mockClear();
      sleepSpy.mockImplementation(async (ms, value, options) => {
        if (ms === 50) {
          paused.resolve();
          await resume.promise;
        }
        return await realSleep(ms, value, options);
      });
      startReconcile({ ...databaseOptions, preferredSessionId: scope.sessionId });
      const completed = waitForReconcile(databaseOptions);
      await awaitGateBeforeSettlement(
        paused.promise,
        completed,
        "reconciliation completed without awaiting backoff",
      );
      expect(countAgentDatabaseLeases(database.path, env)).toBe(baselineLeaseCount + 1);
      startReconcile({ ...databaseOptions, preferredSessionId: readyScope.sessionId });
      await seed(scope, "during-backoff", "queued while paused");
      await waitForProjection(readyScope);
      expect(isReconciling(databaseOptions)).toBe(true);
      resume.resolve();
      await completed;
      expect(injectedPending).toBe(6);
      expect(sleepSpy.mock.calls).toEqual([[0], [50], [200], [500], [1_000], [1_000]]);
      expect(rebuildState(database.db, scope.sessionId)).toEqual({ needs_rebuild: 0 });
      expect(readProjectedTranscript(database, scope.sessionId)).toHaveLength(2);
      expect(isReconciling(databaseOptions)).toBe(false);
      expect(countAgentDatabaseLeases(database.path, env)).toBe(baselineLeaseCount + 1);
    } finally {
      injectPending = false;
      resume.resolve();
      await waitForReconcile(databaseOptions);
      sleepSpy.mockRestore();
      await closeDatabases();
    }
  }, 30_000);

  it.each([false, true])(
    "keeps canonical publication distinct from parent cache eviction (explicit close: %s)",
    (explicitClose) =>
      withFakeClockState("openclaw-reconcile-retained-", async () => {
        const databaseOptions = { agentId: "main" };
        const scope = scopeFor("retained-primary", databaseOptions);
        using canonical = observeCanonicalWriterLeases();
        await seed(scope, "retained-message", "Retained transcript");
        await waitForReconcile(databaseOptions);
        const database = openDatabase(databaseOptions);
        const expected = readProjectedTranscript(database, scope.sessionId);
        expect(expected).toHaveLength(1);
        markDirty(database.db, scope.sessionId);
        const probe = holdReconcileAck(observer, "plan-finish", scope.sessionId);
        const outcome = settledOutcome(reconcile(databaseOptions));
        try {
          await awaitGateBeforeSettlement(
            probe.paused,
            outcome,
            "worker settled before the final acknowledgement",
          );
          expect(probe.threadId()).toBeGreaterThan(0);
          const canonicalLeaseId = canonical.leases.get(database.path);
          const plannerLeaseId = probe.plannerLeases.get(database.path);
          expect(canonicalLeaseId).toMatch(/^[a-f0-9-]+$/u);
          expect(plannerLeaseId).toMatch(/^[a-f0-9-]+$/u);
          expect(canonicalLeaseId).not.toBe(plannerLeaseId);
          expect(countAgentDatabaseLeases(database.path)).toBe(3);
          expect(database.db.isOpen).toBe(true);
          if (explicitClose) {
            expect(closeOpenClawAgentDatabaseByPath(database.path)).toBe(true);
            expect(database.db.isOpen).toBe(false);
            expect(() => assertNoOpenClawAgentDatabaseLeases("main")).toThrow(
              "still open in another process",
            );
          } else {
            // Ordinary cache eviction must not revoke the separately retained publication owner.
            closeCachedOpenClawAgentDatabase(database);
            expect(database.db.isOpen).toBe(false);
            expectLeases(database.path, canonicalLeaseId, plannerLeaseId);
          }
        } finally {
          probe.release();
          await outcome;
        }
        await expect(outcome).resolves.toEqual({
          status: "fulfilled",
          value: { reconciledSessions: 1 },
        });
        if (explicitClose) {
          await closeDatabase(database.path);
          expect(readAgentDatabaseLeaseIds(database.path)).toEqual([]);
        } else {
          expect(readAgentDatabaseLeaseIds(database.path)).toEqual([
            canonical.leases.get(database.path),
          ]);
          await vi.advanceTimersByTimeAsync(SQLITE_IDLE_HANDLE_TTL_MS);
          // Timer dispatch starts native retirement; settlement must join its asynchronous close.
          await vi.waitFor(() => expect(readAgentDatabaseLeaseIds(database.path)).toEqual([]));
        }
        const settled = openDatabase(databaseOptions);
        expect(settled).not.toBe(database);
        // Retirement after the final commit cannot discard its acknowledged projection.
        expect(readProjectedTranscript(settled, scope.sessionId)).toEqual(expected);
      }),
    30_000,
  );

  it.each(["clean", "worker-create", "preflight-transaction", "preflight-commit"] as const)(
    "releases its handle for idle retirement after %s preflight/worker startup",
    (mode) =>
      withFakeClockState("openclaw-reconcile-startup-release-", async () => {
        const options = { agentId: "main" };
        const scope = scopeFor("startup-release", options);
        await seed(scope, "startup-message", "Startup release");
        await waitForReconcile(options);
        const database = openDatabase(options);
        if (mode === "clean") {
          // Admit the initial status once; the measured clean read needs no write grants.
          await reconcile(options);
        } else {
          markDirty(database.db, scope.sessionId);
        }
        const admissionSpy = workerProbe.admission(admission, (request, grant, admit) => {
          if (request.stage === "transaction" || request.stage === "commit") {
            if (mode === `preflight-${request.stage}`) {
              throw new Error(mode);
            }
          }
          admit(request, grant);
        });
        const createWorker = vi.fn().mockImplementationOnce(() => {
          throw new Error("worker-create");
        });
        observer.beforeCreate = createWorker;
        try {
          const operation = reconcile(options);
          if (mode === "clean") {
            await expect(operation).resolves.toEqual({ reconciledSessions: 0 });
          } else {
            await expect(operation).rejects.toThrow(mode);
          }
          expect(database.db.isTransaction).toBe(false);
          expect(rebuildState(database.db, scope.sessionId)).toEqual({
            needs_rebuild: mode === "clean" ? 0 : 1,
          });
        } finally {
          admissionSpy.mockRestore();
          observer.beforeCreate = undefined;
        }
        await expectIdleRetirement(database);
      }),
    30_000,
  );

  it.each([
    { expectedTerminal: "done" as const, failAfterFirstPlan: false },
    { expectedTerminal: "failed" as const, failAfterFirstPlan: true },
  ])(
    "keeps the operation pending until lease release after $expectedTerminal",
    ({ expectedTerminal, failAfterFirstPlan }) =>
      withFakeClockState("openclaw-transcript-worker-cleanup-", async () => {
        const primarySessionId = "cleanup-primary";
        const primaryScope = scopeFor(primarySessionId);
        using canonical = observeCanonicalWriterLeases();
        await seed(primaryScope, "primary-message", "primary");
        if (failAfterFirstPlan) {
          await seed(scopeFor("cleanup-malformed"), "malformed-message", "malformed");
        }
        await waitForReconcile({ agentId: "main" });
        await closeDatabase(databasePathFor({ agentId: "main" }));

        const database = openDatabase({ agentId: "main" });
        const databasePath = database.path;
        markDirty(database.db, primarySessionId);
        if (failAfterFirstPlan) {
          markDirty(database.db, "cleanup-malformed");
          database.db
            .prepare(
              "UPDATE transcript_events SET event_json = '{' WHERE session_id = ? AND seq = 1",
            )
            .run("cleanup-malformed");
        }

        const baselineLeases = readAgentDatabaseLeaseIds(databasePath);
        expect(baselineLeases).toHaveLength(1);
        const probe = createCleanupFenceProbe();
        let settled = false;
        const outcome = settledOutcome(
          reconcile({ agentId: "main", preferredSessionId: primarySessionId }),
        );

        void outcome.then(() => {
          settled = true;
        });
        try {
          await probe.planStarted;
          const canonicalLease = canonical.leases.get(databasePath);
          const plannerLease = probe.plannerLeaseId();
          expect(canonicalLease).toMatch(/^[a-f0-9-]+$/u);
          expect(plannerLease).toMatch(/^[a-f0-9-]+$/u);
          expect(canonicalLease).not.toBe(plannerLease);
          const activeLeases = [...baselineLeases, canonicalLease, plannerLease];
          expectLeases(databasePath, ...activeLeases);
          await waitForCurrentProjection(databasePath, primarySessionId);
          await expect(probe.terminal).resolves.toBe(expectedTerminal);
          await timers.setTimeout(25);
          expect(settled).toBe(false);
          expectLeases(databasePath, ...activeLeases);
        } finally {
          probe.release();
        }

        const result = await outcome;
        expectLeases(databasePath, ...baselineLeases, canonical.leases.get(databasePath));
        if (expectedTerminal === "done") {
          expect(result).toEqual({ status: "fulfilled", value: { reconciledSessions: 1 } });
        } else {
          expect(result.status).toBe("rejected");
        }
        await expectIdleRetirement(database);
      }),
    20_000,
  );
});
