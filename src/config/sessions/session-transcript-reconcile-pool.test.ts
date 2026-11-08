import path from "node:path";
import { setImmediate } from "node:timers/promises";
import type { Worker } from "node:worker_threads";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { readGatewayLockProcessNamespace } from "../../infra/gateway-lock-payload.js";
import * as nativeWorkerRecovery from "../../infra/gateway-native-worker-recovery.js";
import { acquireGatewayStateOwner } from "../../infra/gateway-state-owner.js";
import * as admissionTurn from "../../infra/sqlite-database-admission-turn.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { drainGlobalSingletonLifecycleState } from "../../shared/global-singleton.js";
import {
  closeOpenClawAgentDatabaseByPathAsync as closeDatabase,
  closeOpenClawAgentDatabasesAsync,
  openOpenClawAgentDatabase as openDatabase,
  resolveOpenClawAgentSqlitePath,
} from "../../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../runtime-snapshot.js";
import { persistSessionTranscriptTurn } from "./session-accessor.js";
import {
  closeSessionTranscriptReconcileWorkerPool as closePool,
  getSessionTranscriptReconcileWorkerPoolSnapshot as poolSnapshot,
  runSessionTranscriptReconcileOperation as runOperation,
} from "./session-transcript-reconcile-pool.js";
import {
  observeCanonicalWriterLeases,
  readAgentDatabaseLeaseIds,
} from "./session-transcript-reconcile.fixtures.test-support.js";
import {
  isSessionTranscriptIndexReconcileRunning as isReconciling,
  reconcileSessionTranscriptIndexes as reconcile,
  startSessionTranscriptIndexReconcile as startReconcile,
  waitForSessionTranscriptIndexReconcile as waitForReconcile,
} from "./session-transcript-reconcile.js";
import { useReconcileWorkerObserver } from "./session-transcript-reconcile.test-support.js";

vi.mock("node:worker_threads", async () =>
  (await import("./session-transcript-reconcile.test-support.js")).createObservedWorkerThreads(),
);

const observer = useReconcileWorkerObserver();
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
type DatabaseOptions = Parameters<typeof reconcile>[0];
type Database = ReturnType<typeof openDatabase>;

function transcriptRows(database: Database, sessionId: string) {
  return database.db
    .prepare("SELECT seq, event_json FROM transcript_events WHERE session_id = ? ORDER BY seq")
    .all(sessionId);
}

function expectFts(database: Database, messageId: string, text: string) {
  expect(database.db.prepare("SELECT message_id, text FROM session_transcript_fts").all()).toEqual([
    { message_id: messageId, text },
  ]);
}

function requiredLease(leases: ReadonlyMap<string, string>, pathname: string) {
  const id = expectDefined(leases.get(pathname), "worker lease");
  expect(id).toEqual(expect.any(String));
  return id;
}

function fixture(name: string) {
  const stateDir = tempDirs.make(`openclaw-reconcile-${name}-`);
  const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
  setRuntimeConfigSnapshot({});
  return { stateDir, env, options: { agentId: "main", env } };
}

async function openDirtyDatabase(options: DatabaseOptions & { env: NodeJS.ProcessEnv }) {
  await closeDatabase(resolveOpenClawAgentSqlitePath(options));
  const database = openDatabase(options);
  const nativeLeases = readAgentDatabaseLeaseIds(database.path, options.env);
  expect(nativeLeases).toHaveLength(1);
  database.db.prepare("UPDATE session_transcript_index_state SET needs_rebuild = 1").run();
  return { database, nativeLeases };
}

function expectPool(snapshot: Partial<ReturnType<typeof poolSnapshot>>) {
  expect(poolSnapshot()).toMatchObject(snapshot);
}

async function expectReconciled(options: DatabaseOptions, reconciledSessions: number) {
  await expect(reconcile(options)).resolves.toEqual({ reconciledSessions });
}

function planGate(
  observe: (task: Parameters<NonNullable<typeof observer.onTask>>[0]) => boolean,
  events?: string[],
) {
  const ready = createDeferredCore();
  let acknowledgement: (() => void) | undefined;
  let worker: Worker | undefined;
  observer.onTask = (task) => {
    if (!observe(task)) {
      return;
    }
    if (task.input.mode === "disk") {
      worker = task.worker;
    }
    const post = task.port.postMessage.bind(task.port);
    let finishing = false;
    task.observeMessage((message) => {
      finishing = message.type === "plan-finish";
      if (message.type === "lease-released") {
        events?.push("worker-release");
      }
    });
    task.port.postMessage = (message: unknown, transferList) => {
      const send = () =>
        post(message, Array.isArray(transferList) ? { transfer: transferList } : transferList);
      if (!finishing) {
        return send();
      }
      finishing = false;
      acknowledgement = send;
      ready.resolve();
    };
  };
  return {
    ready: ready.promise,
    get worker() {
      return expectDefined(worker, "active planner worker");
    },
    resume() {
      acknowledgement?.();
      acknowledgement = undefined;
    },
    async terminate() {
      acknowledgement = undefined;
      await this.worker.terminate();
    },
  };
}

async function seed(
  options: { agentId: string; env: NodeJS.ProcessEnv },
  sessionId: string,
  content: string,
  eventId = "seed",
  sessionKey = `agent:${options.agentId}:${sessionId}`,
) {
  await persistSessionTranscriptTurn(
    { ...options, sessionId, sessionKey },
    { messages: [{ eventId, message: { role: "user", content } }], touchSessionEntry: false },
  );
  await waitForReconcile(options);
}

async function cleanup(stateDir: string) {
  await closePool();
  await closeOpenClawAgentDatabasesAsync(stateDir);
  closeOpenClawStateDatabaseForTest();
  clearRuntimeConfigSnapshot();
}

it("closes a queued admission without dispatching it after shutdown", async () => {
  const { stateDir, env } = fixture("queued-admission");
  const database = openDatabase({ agentId: "main", env });
  const resume = createDeferredCore();
  const queued = createDeferredCore();
  let admissionCompletion: Promise<unknown> | undefined;
  const admissionSpy = vi
    .spyOn(admissionTurn, "runWithSqliteDatabaseAdmissionTurn")
    .mockImplementationOnce((_paths, run) => {
      queued.resolve();
      const completion = resume.promise.then(run);
      admissionCompletion = completion;
      return completion;
    });
  const dispatch = vi.fn();
  observer.onTask = dispatch;
  const operation = runOperation(async (owner) => {
    const task = await owner.startTask({
      mode: "disk",
      agentId: "main",
      path: database.path,
      stateDir,
      leaseId: "queued-admission",
      externallySupervised: false,
      sessionIds: [],
    });
    await task.completion.finally(() => task.port.close());
  });
  const outcome = Promise.allSettled([operation]);
  let closed = false;
  let closing: Promise<void> | undefined;
  try {
    await queued.promise;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    closing = closePool().then(() => {
      closed = true;
    });
    await vi.advanceTimersByTimeAsync(5_000);
    await setImmediate();
    expect(closed).toBe(true);
    expect(await outcome).toEqual([expect.objectContaining({ status: "rejected" })]);
    resume.resolve();
    await admissionCompletion?.catch(() => {});
    expect(dispatch).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
    resume.resolve();
    await outcome;
    await closing;
    admissionSpy.mockRestore();
    await cleanup(stateDir);
  }
});

it("reconciles a dirty projection while the parent retains serving Gateway ownership", async () => {
  const { stateDir, env, options } = fixture("parent-owner");
  let owner: ReturnType<typeof acquireGatewayStateOwner> | undefined;
  try {
    await seed(options, "parent-owner", "synthetic ownership");
    // Seeding may retain a worker writer; this fixture starts with only its native handle.
    const { database } = await openDirtyDatabase(options);
    owner = acquireGatewayStateOwner({
      databasePath: openOpenClawStateDatabase({ env }).path,
      payload: {
        pid: process.pid,
        processNamespace: readGatewayLockProcessNamespace(),
        createdAt: new Date().toISOString(),
        configPath: path.join(stateDir, "openclaw.json"),
        stateDir,
        role: "gateway",
      },
    });
    await expectReconciled(options, 1);
    owner.assertCurrent();
    expectFts(database, "seed", "synthetic ownership");
  } finally {
    await cleanup(stateDir).finally(() => owner?.release());
  }
}, 30_000);

it.each(["complete", "native-exit"] as const)(
  "drains active and queued reconciliation through %s before retiring its lifecycle",
  async (ending) => {
    const { stateDir, env } = fixture("pool-close");
    const targets = ["active", "queued", "next"].map((agentId) => ({ agentId, env }));
    const sessionId = "lifecycle-session";
    const nativeLeases = new Map<string, string[]>();
    let gate: ReturnType<typeof planGate> | undefined;
    let operations: Promise<PromiseSettledResult<unknown>[]> | undefined;
    try {
      using canonical = observeCanonicalWriterLeases();
      for (const options of targets) {
        await seed(
          options,
          sessionId,
          options.agentId,
          options.agentId,
          `agent:${options.agentId}:lifecycle`,
        );
        const { database, nativeLeases: baseline } = await openDirtyDatabase(options);
        nativeLeases.set(database.path, baseline);
      }
      await closePool();
      gate = planGate(({ input }) => input.mode === "disk" && input.agentId === "active");
      const direct = reconcile(targets[0]!);
      startReconcile(targets[1]!);
      operations = Promise.allSettled([direct, waitForReconcile(targets[1]!)]);
      await gate.ready;
      await vi.waitFor(() => {
        expectPool({ workers: 1, activeTasks: 1 });
      });
      const threadId = gate.worker.threadId;
      let closed = false;
      const closing = closePool().then(() => {
        closed = true;
      });
      await expect(reconcile(targets[2]!)).rejects.toThrow("lifecycle is closed");
      startReconcile(targets[2]!);
      expect(isReconciling(targets[2]!)).toBe(false);
      expect(closed).toBe(false);
      if (ending === "native-exit") {
        await gate.terminate();
      } else {
        gate.resume();
      }
      const results = await operations;
      await closing;
      expect(results.map((result) => result.status)).toEqual([
        ending === "native-exit" ? "rejected" : "fulfilled",
        "fulfilled",
      ]);
      expectPool({ workers: 0, activeTasks: 0, pendingTasks: 0 });
      for (const options of targets.slice(0, 2)) {
        const database = openDatabase(options);
        const actual = readAgentDatabaseLeaseIds(database.path, env);
        const canonicalId = requiredLease(canonical.leases, database.path);
        expect(actual).toEqual([...nativeLeases.get(database.path)!, canonicalId].toSorted());
        expectFts(database, options.agentId, options.agentId);
      }
      observer.onTask = ({ worker }) => {
        expect(worker.threadId).not.toBe(threadId);
      };
      await expectReconciled(targets[2]!, 1);
      expectPool({ workers: 1, workersCreated: 1 });
      await drainGlobalSingletonLifecycleState("restart");
      expect(poolSnapshot().workers).toBe(0);
    } finally {
      gate?.resume();
      await operations;
      await cleanup(stateDir);
    }
  },
  30_000,
);

it.each(["complete", "native-exit", "pool-timeout", "task-timeout", "stalled-retirement"] as const)(
  "joins transcript lease settlement before closing an agent (%s)",
  async (ending) => {
    const { stateDir, env, options } = fixture("agent-close");
    const events: string[] = [];
    using recovery = vi
      .spyOn(nativeWorkerRecovery, "requestGatewayNativeWorkerRecovery")
      .mockResolvedValue({
        status: "report-only",
        reason: "Synthetic test has no Gateway process lifecycle.",
      });
    let gate: ReturnType<typeof planGate> | undefined;
    let reconciliation: Promise<PromiseSettledResult<unknown>[]> | undefined;
    let closing: Promise<boolean> | undefined;
    let closeSpy: { mockRestore(): void } | undefined;
    try {
      await seed(options, "settlement", "retained bytes");
      const orphanSessionId = "deferred-orphan";
      if (ending === "complete") {
        await seed(options, orphanSessionId, "orphan", "orphan-message");
      }
      await closePool();
      await closeDatabase(resolveOpenClawAgentSqlitePath(options));
      const database = openDatabase(options);
      const nativeLeases = readAgentDatabaseLeaseIds(database.path, env);
      expect(nativeLeases).toHaveLength(1);
      const original = transcriptRows(database, "settlement");
      expect(original).not.toEqual([]);
      database.db
        .prepare("UPDATE session_transcript_index_state SET needs_rebuild = 1 WHERE session_id = ?")
        .run("settlement");
      gate = planGate(({ input }) => {
        if (input.mode === "release") {
          events.push("release-task");
        }
        return true;
      }, events);
      if (ending === "task-timeout" || ending === "stalled-retirement") {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      }
      reconciliation = Promise.allSettled([reconcile(options)]);
      await gate.ready;
      const close = database.db.close.bind(database.db);
      let leasesAtNativeClose: string[] | undefined;
      closeSpy = vi.spyOn(database.db, "close").mockImplementation(() => {
        leasesAtNativeClose = readAgentDatabaseLeaseIds(database.path, env);
        events.push("native-close");
        close();
      });
      if (ending === "complete") {
        // Simulate an orphan appearing after preflight, while the finalized plan's ACK is held.
        database.db
          .prepare("DELETE FROM transcript_events WHERE session_id = ?")
          .run(orphanSessionId);
      }
      if (ending === "pool-timeout") {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        const terminate = vi.spyOn(gate.worker, "terminate");
        const poolClosing = closePool();
        await vi.advanceTimersByTimeAsync(4_999);
        expect(terminate).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(terminate).toHaveBeenCalledOnce();
        vi.useRealTimers();
        await poolClosing;
      }
      if (ending === "task-timeout" || ending === "stalled-retirement") {
        const native = gate.worker;
        const nativeTerminate = native.terminate.bind(native);
        const retirement = createDeferredCore<number>();
        const terminate = vi.spyOn(native, "terminate");
        if (ending === "stalled-retirement") {
          terminate.mockReturnValue(retirement.promise);
        }
        expect(terminate).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(180_000);
        expect(terminate).toHaveBeenCalledOnce();
        expect(recovery).not.toHaveBeenCalled();
        if (ending === "stalled-retirement") {
          await vi.advanceTimersByTimeAsync(5_000);
          await vi.dynamicImportSettled();
          expect(recovery).toHaveBeenCalledOnce();
          expect(recovery.mock.calls[0]![0].isCurrent()).toBe(true);
          expect(native.threadId).toBeGreaterThan(0);
          expect(readAgentDatabaseLeaseIds(database.path, env).length).toBeGreaterThan(
            nativeLeases.length,
          );
          expect(events).not.toContain("release-task");
          retirement.resolve(await nativeTerminate());
        }
        terminate.mockRestore();
        vi.useRealTimers();
      }
      closing = closeDatabase(database.path);
      if (ending === "native-exit") {
        await gate.terminate();
      } else if (ending === "complete") {
        gate.resume();
      }
      await expect(closing).resolves.toBe(true);
      const [result] = await reconciliation;
      expect(result).toEqual(
        ending !== "complete"
          ? expect.objectContaining({ status: "rejected" })
          : { status: "fulfilled", value: { reconciledSessions: 1 } },
      );
      expect(events).toEqual(
        ending !== "complete"
          ? ["release-task", "worker-release", "native-close"]
          : ["worker-release", "native-close"],
      );
      expect(database.db.isOpen).toBe(false);
      if (ending === "stalled-retirement") {
        expect(recovery.mock.calls[0]![0].isCurrent()).toBe(false);
      } else {
        expect(recovery).not.toHaveBeenCalled();
      }
      expect(leasesAtNativeClose).toEqual(nativeLeases);
      expect(readAgentDatabaseLeaseIds(database.path, env)).toEqual([]);
      const reopened = openDatabase(options);
      expect(transcriptRows(reopened, "settlement")).toEqual(original);
      if (ending === "complete") {
        const tables = [
          "session_transcript_index_state",
          "session_transcript_fts_rows",
          "session_transcript_fts",
        ];
        const orphanCounts = () =>
          tables.map(
            (table) =>
              reopened.db
                .prepare(`SELECT count(*) AS count FROM ${table} WHERE session_id = ?`)
                .get(orphanSessionId)?.count,
          );
        expect(orphanCounts()).toEqual([1, 1, 1]);
        observer.onTask = undefined;
        await expectReconciled(options, 0);
        expect(orphanCounts()).toEqual([0, 0, 0]);
      }
    } finally {
      vi.useRealTimers();
      gate?.resume();
      await reconciliation;
      await closing?.catch(() => {});
      closeSpy?.mockRestore();
      await cleanup(stateDir);
    }
  },
);

it("revokes scheduled reconciliation before its first disk admission", async () => {
  const { stateDir, env, options } = fixture("delayed-admission");
  const resume = createDeferredCore();
  const originalRun = runOperation;
  const pool = await import("./session-transcript-reconcile-pool.js");
  let closing: Promise<boolean> | undefined;
  let completion: Promise<void> | undefined;
  try {
    await seed(options, "delayed", "retained bytes");
    const database = openDatabase(options);
    database.db.prepare("UPDATE session_transcript_index_state SET needs_rebuild = 1").run();
    const task = vi.fn();
    observer.onTask = task;
    const operationSpy = vi.spyOn(pool, "runSessionTranscriptReconcileOperation");
    operationSpy.mockImplementationOnce((run, owner) =>
      originalRun(async (operation) => {
        await resume.promise;
        return run(operation);
      }, owner),
    );
    startReconcile(options);
    completion = waitForReconcile(options);
    closing = closeDatabase(database.path);
    resume.resolve();
    await Promise.all([completion, closing]);
    operationSpy.mockRestore();
    expect(task).not.toHaveBeenCalled();
    expect(database.db.isOpen).toBe(false);
    expect(readAgentDatabaseLeaseIds(database.path, env)).toEqual([]);
  } finally {
    resume.resolve();
    await completion;
    await closing?.catch(() => {});
    vi.restoreAllMocks();
    await cleanup(stateDir);
  }
});
