import path from "node:path";
import { setImmediate } from "node:timers/promises";
import type { Worker } from "node:worker_threads";
import { expectDefined } from "@openclaw/normalization-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { acquireGatewayStateOwner } from "../../infra/gateway-state-owner.js";
import * as admissionTurn from "../../infra/sqlite-database-admission-turn.js";
import * as admission from "../../infra/sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe as probe } from "../../infra/sqlite-worker-owner-probe.test-support.js";
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

function holdPlanFinish(
  task: Parameters<NonNullable<typeof observer.onTask>>[0],
  hold: (release: () => void) => void,
  events?: string[],
) {
  const postMessage = task.port.postMessage.bind(task.port);
  let finishing = false;
  task.observeMessage((message) => {
    finishing = message.type === "plan-finish";
    if (message.type === "lease-released") {
      events?.push("worker-release");
    }
  });
  task.port.postMessage = (message: unknown, transferList) => {
    const transfer = Array.isArray(transferList) ? { transfer: transferList } : transferList;
    if (finishing) {
      finishing = false;
      hold(() => postMessage(message, transfer));
    } else {
      postMessage(message, transfer);
    }
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
  const stateDir = tempDirs.make("openclaw-reconcile-queued-admission-");
  const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
  setRuntimeConfigSnapshot({});
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
    try {
      await task.completion;
    } finally {
      task.port.close();
    }
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

function readAgentDatabaseLeaseIds(pathname: string, env: NodeJS.ProcessEnv): string[] {
  return openOpenClawStateDatabase({ env })
    .db.prepare(
      "SELECT lease_id FROM agent_database_leases WHERE owner_pid = ? AND path = ? ORDER BY lease_id",
    )
    .all(process.pid, pathname)
    .map((row) => String(row.lease_id));
}

function observeCanonicalWriterLeases() {
  const leases = new Map<string, string>();
  const spy = probe.admission(admission, (request, grant, admit) => {
    const facts = request.facts;
    if (
      request.stage === "open" &&
      isRecord(facts) &&
      typeof facts.databasePath === "string" &&
      typeof facts.leaseId === "string"
    ) {
      leases.set(facts.databasePath, facts.leaseId);
    }
    admit(request, grant);
  });
  return { leases, restore: () => spy.mockRestore() };
}

it("reconciles a dirty projection while the parent retains serving Gateway ownership", async () => {
  const stateDir = tempDirs.make("openclaw-reconcile-parent-owner-");
  const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
  const options = { agentId: "main", env };
  const canonical = observeCanonicalWriterLeases();
  let owner: ReturnType<typeof acquireGatewayStateOwner> | undefined;
  try {
    setRuntimeConfigSnapshot({});
    await seed(options, "parent-owner", "synthetic ownership");
    // Seeding may retain a worker writer; this fixture starts with only its native handle.
    await closeDatabase(resolveOpenClawAgentSqlitePath(options));
    const database = openDatabase(options);
    const nativeLeases = readAgentDatabaseLeaseIds(database.path, env);
    expect(nativeLeases).toHaveLength(1);
    let plannerLeaseId: string | undefined;
    observer.onTask = ({ input }) => {
      if (input.mode === "disk" && input.path === database.path) {
        plannerLeaseId = input.leaseId;
      }
    };
    database.db.prepare("UPDATE session_transcript_index_state SET needs_rebuild = 1").run();
    owner = acquireGatewayStateOwner({
      databasePath: openOpenClawStateDatabase({ env }).path,
      payload: {
        pid: process.pid,
        createdAt: new Date().toISOString(),
        configPath: path.join(stateDir, "openclaw.json"),
        stateDir,
        role: "gateway",
      },
    });
    await expect(reconcile(options)).resolves.toEqual({
      reconciledSessions: 1,
    });
    owner.assertCurrent();
    const canonicalLeaseId = expectDefined(
      canonical.leases.get(database.path),
      "canonical writer lease",
    );
    expect(canonicalLeaseId).toEqual(expect.any(String));
    expect(plannerLeaseId).toEqual(expect.any(String));
    expect(new Set([...nativeLeases, canonicalLeaseId, plannerLeaseId]).size).toBe(3);
    expect(readAgentDatabaseLeaseIds(database.path, env)).toEqual(
      [...nativeLeases, canonicalLeaseId].toSorted(),
    );
    expect(
      database.db.prepare("SELECT message_id, text FROM session_transcript_fts").all(),
    ).toEqual([{ message_id: "seed", text: "synthetic ownership" }]);
  } finally {
    canonical.restore();
    try {
      await cleanup(stateDir);
    } finally {
      owner?.release();
    }
  }
}, 30_000);

it.each(["complete", "native-exit"] as const)(
  "drains active and queued reconciliation through %s before retiring its lifecycle",
  async (ending) => {
    const stateDir = tempDirs.make("openclaw-reconcile-pool-close-");
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    const targets = ["active", "queued", "next"].map((agentId) => ({ agentId, env }));
    const paused = createDeferredCore();
    let releaseAcknowledgement: (() => void) | undefined;
    let activeWorker: Worker | undefined;
    const modes: string[] = [];
    const sessionId = "lifecycle-session";
    const canonical = observeCanonicalWriterLeases();
    const nativeLeases = new Map<string, string[]>();
    const plannerLeases = new Map<string, string>();
    let operations: Promise<PromiseSettledResult<unknown>[]> | undefined;
    try {
      setRuntimeConfigSnapshot({});
      for (const options of targets) {
        await seed(
          options,
          sessionId,
          options.agentId,
          options.agentId,
          `agent:${options.agentId}:lifecycle`,
        );
        await closeDatabase(resolveOpenClawAgentSqlitePath(options));
        const database = openDatabase(options);
        const baseline = readAgentDatabaseLeaseIds(database.path, env);
        expect(baseline).toHaveLength(1);
        nativeLeases.set(database.path, baseline);
        database.db.prepare("UPDATE session_transcript_index_state SET needs_rebuild = 1").run();
      }
      await closePool();
      observer.onTask = (task) => {
        const { input, worker } = task;
        modes.push(input.mode);
        if (input.mode === "disk") {
          plannerLeases.set(input.path, input.leaseId);
        }
        if (input.mode !== "disk" || input.agentId !== "active") {
          return;
        }
        activeWorker = worker;
        holdPlanFinish(task, (release) => {
          releaseAcknowledgement = release;
          paused.resolve();
        });
      };
      const direct = reconcile(targets[0]!);
      startReconcile(targets[1]!);
      operations = Promise.allSettled([direct, waitForReconcile(targets[1]!)]);
      await paused.promise;
      await vi.waitFor(() => {
        expect(poolSnapshot()).toMatchObject({
          workers: 1,
          activeTasks: 1,
        });
      });
      const activePath = openDatabase(targets[0]!).path;
      const canonicalLeaseId = expectDefined(
        canonical.leases.get(activePath),
        "canonical writer lease",
      );
      const plannerLeaseId = expectDefined(plannerLeases.get(activePath), "planner lease");
      expect(canonicalLeaseId).toEqual(expect.any(String));
      expect(plannerLeaseId).toEqual(expect.any(String));
      const activeLeases = [...nativeLeases.get(activePath)!, canonicalLeaseId, plannerLeaseId];
      expect(new Set(activeLeases).size).toBe(3);
      expect(readAgentDatabaseLeaseIds(activePath, env)).toEqual(activeLeases.toSorted());
      const threadId = activeWorker!.threadId;
      let closed = false;
      const closing = closePool().then(() => {
        closed = true;
      });
      await expect(reconcile(targets[2]!)).rejects.toThrow("lifecycle is closed");
      startReconcile(targets[2]!);
      expect(isReconciling(targets[2]!)).toBe(false);
      expect(closed).toBe(false);
      if (ending === "native-exit") {
        releaseAcknowledgement = undefined;
        await activeWorker!.terminate();
      } else {
        releaseAcknowledgement!();
        releaseAcknowledgement = undefined;
      }
      const results = await operations;
      await closing;
      expect(results.map((result) => result.status)).toEqual([
        ending === "native-exit" ? "rejected" : "fulfilled",
        "fulfilled",
      ]);
      // Across agents, planning and lease recovery join the FIFO worker as they become ready.
      expect(modes.toSorted()).toEqual(
        ending === "native-exit" ? ["disk", "disk", "release"] : ["disk", "disk"],
      );
      expect(poolSnapshot()).toMatchObject({
        workers: 0,
        activeTasks: 0,
        pendingTasks: 0,
      });
      for (const options of targets.slice(0, 2)) {
        const database = openDatabase(options);
        const actual = readAgentDatabaseLeaseIds(database.path, env);
        const canonicalId = expectDefined(canonical.leases.get(database.path), "canonical lease");
        const plannerId = plannerLeases.get(database.path);
        expect(canonicalId).toEqual(expect.any(String));
        expect(plannerId).toEqual(expect.any(String));
        expect(canonicalId).not.toBe(plannerId);
        expect(actual).not.toContain(plannerId);
        expect(actual).toEqual(
          [...nativeLeases.get(database.path)!, canonicalId].toSorted((left, right) =>
            left.localeCompare(right),
          ),
        );
        expect(
          database.db.prepare("SELECT message_id, text FROM session_transcript_fts").all(),
        ).toEqual([{ message_id: options.agentId, text: options.agentId }]);
      }
      observer.onTask = ({ worker }) => {
        expect(worker.threadId).not.toBe(threadId);
      };
      await expect(reconcile(targets[2]!)).resolves.toEqual({
        reconciledSessions: 1,
      });
      expect(poolSnapshot()).toMatchObject({
        workers: 1,
        workersCreated: 1,
      });
      await drainGlobalSingletonLifecycleState("restart");
      expect(poolSnapshot().workers).toBe(0);
    } finally {
      canonical.restore();
      releaseAcknowledgement?.();
      await operations;
      await cleanup(stateDir);
    }
  },
  30_000,
);

it.each(["complete", "native-exit", "pool-timeout"] as const)(
  "joins transcript lease settlement before closing an agent (%s)",
  async (ending) => {
    const stateDir = tempDirs.make("openclaw-reconcile-agent-close-");
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    const options = { agentId: "main", env };
    const paused = createDeferredCore();
    const events: string[] = [];
    let releaseAcknowledgement: (() => void) | undefined;
    let activeWorker: Worker | undefined;
    let reconciliation: Promise<PromiseSettledResult<unknown>[]> | undefined;
    let closing: Promise<boolean> | undefined;
    let closeSpy: { mockRestore(): void } | undefined;
    try {
      setRuntimeConfigSnapshot({});
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
      const readTranscript = () =>
        database.db
          .prepare(
            "SELECT seq, event_json FROM transcript_events WHERE session_id = ? ORDER BY seq",
          )
          .all("settlement");
      const original = readTranscript();
      expect(original).not.toEqual([]);
      database.db
        .prepare("UPDATE session_transcript_index_state SET needs_rebuild = 1 WHERE session_id = ?")
        .run("settlement");
      observer.onTask = (task) => {
        const { input, worker } = task;
        if (input.mode === "release") {
          events.push("release-task");
        } else {
          activeWorker = worker;
        }
        holdPlanFinish(
          task,
          (release) => {
            releaseAcknowledgement = release;
            paused.resolve();
          },
          events,
        );
      };
      reconciliation = Promise.allSettled([reconcile(options)]);
      await paused.promise;
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
        const terminate = vi.spyOn(activeWorker!, "terminate");
        const poolClosing = closePool();
        await vi.advanceTimersByTimeAsync(4_999);
        expect(terminate).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(terminate).toHaveBeenCalledOnce();
        vi.useRealTimers();
        await poolClosing;
      }
      closing = closeDatabase(database.path);
      if (ending === "native-exit") {
        releaseAcknowledgement = undefined;
        await activeWorker!.terminate();
      } else if (ending === "complete") {
        releaseAcknowledgement!();
        releaseAcknowledgement = undefined;
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
      expect(leasesAtNativeClose).toEqual(nativeLeases);
      expect(readAgentDatabaseLeaseIds(database.path, env)).toEqual([]);
      const reopened = openDatabase(options);
      expect(
        reopened.db
          .prepare(
            "SELECT seq, event_json FROM transcript_events WHERE session_id = ? ORDER BY seq",
          )
          .all("settlement"),
      ).toEqual(original);
      if (ending === "complete") {
        const count = (table: string) =>
          reopened.db
            .prepare(`SELECT count(*) AS count FROM ${table} WHERE session_id = ?`)
            .get(orphanSessionId);
        const orphanRows = () => ({
          index: count("session_transcript_index_state"),
          identities: count("session_transcript_fts_rows"),
          content: count("session_transcript_fts"),
        });
        expect(orphanRows()).toEqual({
          index: { count: 1 },
          identities: { count: 1 },
          content: { count: 1 },
        });
        observer.onTask = undefined;
        await expect(reconcile(options)).resolves.toEqual({
          reconciledSessions: 0,
        });
        expect(orphanRows()).toEqual({
          index: { count: 0 },
          identities: { count: 0 },
          content: { count: 0 },
        });
      }
    } finally {
      vi.useRealTimers();
      releaseAcknowledgement?.();
      await reconciliation;
      await closing?.catch(() => {});
      closeSpy?.mockRestore();
      await cleanup(stateDir);
    }
  },
);

it("revokes scheduled reconciliation before its first disk admission", async () => {
  const stateDir = tempDirs.make("openclaw-reconcile-delayed-admission-");
  const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
  const options = { agentId: "main", env };
  const resume = createDeferredCore();
  const originalRun = runOperation;
  const pool = await import("./session-transcript-reconcile-pool.js");
  let closing: Promise<boolean> | undefined;
  let completion: Promise<void> | undefined;
  try {
    setRuntimeConfigSnapshot({});
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
