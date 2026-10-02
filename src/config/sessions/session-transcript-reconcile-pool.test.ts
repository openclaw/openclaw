import path from "node:path";
import type { Worker } from "node:worker_threads";
import { expectDefined } from "@openclaw/normalization-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { acquireGatewayStateOwner } from "../../infra/gateway-state-owner.js";
import * as admission from "../../infra/sqlite-worker-operation-admission.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { drainGlobalSingletonLifecycleState } from "../../shared/global-singleton.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  closeOpenClawAgentDatabasesAsync,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { persistSessionTranscriptTurn } from "./session-accessor.js";
import {
  captureSessionTranscriptReconcileGeneration,
  closeSessionTranscriptReconcileWorkerPool,
  getSessionTranscriptReconcileWorkerPoolSnapshot,
  runSessionTranscriptReconcileOperation,
} from "./session-transcript-reconcile-pool.js";
import {
  isSessionTranscriptIndexReconcileRunning,
  reconcileSessionTranscriptIndexes,
  startSessionTranscriptIndexReconcile,
  waitForSessionTranscriptIndexReconcile,
} from "./session-transcript-reconcile.js";
import { useReconcileWorkerObserver } from "./session-transcript-reconcile.test-support.js";

vi.mock("node:worker_threads", async () =>
  (await import("./session-transcript-reconcile.test-support.js")).createObservedWorkerThreads(),
);

const observer = useReconcileWorkerObserver();
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

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
  const createAdmission = admission.createSqliteWorkerOperationAdmission;
  const spy = vi
    .spyOn(admission, "createSqliteWorkerOperationAdmission")
    .mockImplementation((admit, attachment) =>
      createAdmission((request, grant) => {
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
      }, attachment),
    );
  return { leases, restore: () => spy.mockRestore() };
}

it("reconciles a dirty projection while the parent retains serving Gateway ownership", async () => {
  const stateDir = tempDirs.make("openclaw-reconcile-parent-owner-");
  const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
  const options = { agentId: "main", env };
  const canonical = observeCanonicalWriterLeases();
  let owner: ReturnType<typeof acquireGatewayStateOwner> | undefined;
  try {
    await persistSessionTranscriptTurn(
      { ...options, sessionId: "parent-owner", sessionKey: "agent:main:parent-owner" },
      {
        messages: [{ eventId: "seed", message: { role: "user", content: "synthetic ownership" } }],
        touchSessionEntry: false,
      },
    );
    await waitForSessionTranscriptIndexReconcile(options);
    const database = openOpenClawAgentDatabase(options);
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
    await expect(reconcileSessionTranscriptIndexes(options)).resolves.toEqual({
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
      await closeSessionTranscriptReconcileWorkerPool();
      await closeOpenClawAgentDatabasesAsync(stateDir);
      closeOpenClawStateDatabaseForTest();
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
      for (const options of targets) {
        await persistSessionTranscriptTurn(
          { ...options, sessionId, sessionKey: `agent:${options.agentId}:lifecycle` },
          {
            messages: [
              { eventId: options.agentId, message: { role: "user", content: options.agentId } },
            ],
            touchSessionEntry: false,
          },
        );
        await waitForSessionTranscriptIndexReconcile(options);
        const database = openOpenClawAgentDatabase(options);
        const baseline = readAgentDatabaseLeaseIds(database.path, env);
        expect(baseline).toHaveLength(1);
        nativeLeases.set(database.path, baseline);
        database.db.prepare("UPDATE session_transcript_index_state SET needs_rebuild = 1").run();
      }
      await closeSessionTranscriptReconcileWorkerPool();
      observer.onTask = ({ input, worker, port, observeMessage }) => {
        modes.push(input.mode);
        if (input.mode === "disk") {
          plannerLeases.set(input.path, input.leaseId);
        }
        if (input.mode !== "disk" || input.agentId !== "active") {
          return;
        }
        activeWorker = worker;
        const postMessage = port.postMessage.bind(port);
        let finishing = false;
        observeMessage((message) => {
          finishing = message.type === "plan-finish";
        });
        port.postMessage = (message: unknown, transferList) => {
          const options = Array.isArray(transferList) ? { transfer: transferList } : transferList;
          if (finishing) {
            finishing = false;
            releaseAcknowledgement = () => postMessage(message, options);
            paused.resolve();
            return;
          }
          postMessage(message, options);
        };
      };
      const generation = captureSessionTranscriptReconcileGeneration();
      const direct = reconcileSessionTranscriptIndexes(targets[0]!);
      startSessionTranscriptIndexReconcile(targets[1]!);
      operations = Promise.allSettled([
        direct,
        waitForSessionTranscriptIndexReconcile(targets[1]!),
      ]);
      await paused.promise;
      await vi.waitFor(() => {
        expect(getSessionTranscriptReconcileWorkerPoolSnapshot()).toMatchObject({
          workers: 1,
          activeTasks: 1,
          pendingTasks: 2,
        });
      });
      const activePath = openOpenClawAgentDatabase(targets[0]!).path;
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
      const closing = closeSessionTranscriptReconcileWorkerPool().then(() => {
        closed = true;
      });
      const duringClose = captureSessionTranscriptReconcileGeneration();
      await expect(reconcileSessionTranscriptIndexes(targets[2]!)).rejects.toThrow(
        "lifecycle is closed",
      );
      startSessionTranscriptIndexReconcile(targets[2]!);
      expect(isSessionTranscriptIndexReconcileRunning(targets[2]!)).toBe(false);
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
      expect(modes).toEqual(
        ending === "native-exit" ? ["disk", "disk", "release"] : ["disk", "disk"],
      );
      expect(getSessionTranscriptReconcileWorkerPoolSnapshot()).toMatchObject({
        workers: 0,
        activeTasks: 0,
        pendingTasks: 0,
      });
      const retainedCanonicalLeases: string[] = [];
      for (const options of targets.slice(0, 2)) {
        const database = openOpenClawAgentDatabase(options);
        const actual = readAgentDatabaseLeaseIds(database.path, env);
        const canonicalId = canonical.leases.get(database.path);
        const plannerId = plannerLeases.get(database.path);
        expect(canonicalId).toEqual(expect.any(String));
        expect(plannerId).toEqual(expect.any(String));
        expect(canonicalId).not.toBe(plannerId);
        expect(actual).not.toContain(plannerId);
        const retained = actual.filter((id) => id === canonicalId);
        retainedCanonicalLeases.push(...retained);
        expect(actual).toEqual([...nativeLeases.get(database.path)!, ...retained].toSorted());
        expect(
          database.db.prepare("SELECT message_id, text FROM session_transcript_fts").all(),
        ).toEqual([{ message_id: options.agentId, text: options.agentId }]);
      }
      // The canonical executor retains one idle generation across both completed owners.
      expect(retainedCanonicalLeases).toHaveLength(1);
      const late = vi.fn(async () => undefined);
      for (const captured of [generation, duringClose]) {
        await expect(
          runSessionTranscriptReconcileOperation(captured, late, {
            agentId: targets[0]!.agentId,
            path: openOpenClawAgentDatabase(targets[0]!).path,
          }),
        ).rejects.toThrow("lifecycle is closed");
      }
      expect(late).not.toHaveBeenCalled();
      observer.onTask = ({ worker }) => {
        expect(worker.threadId).not.toBe(threadId);
      };
      await expect(reconcileSessionTranscriptIndexes(targets[2]!)).resolves.toEqual({
        reconciledSessions: 1,
      });
      expect(getSessionTranscriptReconcileWorkerPoolSnapshot()).toMatchObject({
        workers: 1,
        workersCreated: 1,
      });
      await drainGlobalSingletonLifecycleState("restart");
      expect(getSessionTranscriptReconcileWorkerPoolSnapshot().workers).toBe(0);
    } finally {
      canonical.restore();
      releaseAcknowledgement?.();
      await operations;
      await closeSessionTranscriptReconcileWorkerPool();
      await closeOpenClawAgentDatabasesAsync(stateDir);
      closeOpenClawStateDatabaseForTest();
    }
  },
  30_000,
);

it.each(["complete", "native-exit"] as const)(
  "joins transcript lease settlement before closing an agent (%s)",
  async (ending) => {
    const stateDir = tempDirs.make("openclaw-reconcile-agent-close-");
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    const options = { agentId: "main", env };
    const paused = createDeferredCore();
    const events: string[] = [];
    const canonical = observeCanonicalWriterLeases();
    let plannerLeaseId: string | undefined;
    let releaseAcknowledgement: (() => void) | undefined;
    let activeWorker: Worker | undefined;
    let reconciliation: Promise<PromiseSettledResult<unknown>[]> | undefined;
    let closing: Promise<boolean> | undefined;
    let closeSpy: { mockRestore(): void } | undefined;
    try {
      await persistSessionTranscriptTurn(
        { ...options, sessionId: "settlement", sessionKey: "agent:main:settlement" },
        {
          messages: [{ eventId: "seed", message: { role: "user", content: "retained bytes" } }],
          touchSessionEntry: false,
        },
      );
      await waitForSessionTranscriptIndexReconcile(options);
      const orphanSessionId = "deferred-orphan";
      if (ending === "complete") {
        await persistSessionTranscriptTurn(
          { ...options, sessionId: orphanSessionId, sessionKey: "agent:main:deferred-orphan" },
          {
            messages: [{ eventId: "orphan-message", message: { role: "user", content: "orphan" } }],
            touchSessionEntry: false,
          },
        );
        await waitForSessionTranscriptIndexReconcile(options);
      }
      await closeSessionTranscriptReconcileWorkerPool();
      const database = openOpenClawAgentDatabase(options);
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
      observer.onTask = ({ input, worker, port, observeMessage }) => {
        if (input.mode === "release") {
          events.push("release-task");
        } else {
          activeWorker = worker;
          if (input.mode === "disk") {
            plannerLeaseId = input.leaseId;
          }
        }
        const postMessage = port.postMessage.bind(port);
        let finishing = false;
        observeMessage((message) => {
          finishing = message.type === "plan-finish";
          if (message.type === "lease-released") {
            events.push("worker-release");
          }
        });
        port.postMessage = (message: unknown, transferList) => {
          const transfer = Array.isArray(transferList) ? { transfer: transferList } : transferList;
          if (finishing) {
            finishing = false;
            releaseAcknowledgement = () => postMessage(message, transfer);
            paused.resolve();
          } else {
            postMessage(message, transfer);
          }
        };
      };
      reconciliation = Promise.allSettled([reconcileSessionTranscriptIndexes(options)]);
      await paused.promise;
      const canonicalLeaseId = expectDefined(
        canonical.leases.get(database.path),
        "canonical writer lease",
      );
      expect(canonicalLeaseId).toEqual(expect.any(String));
      expect(plannerLeaseId).toEqual(expect.any(String));
      const heldLeases = [
        ...nativeLeases,
        canonicalLeaseId,
        expectDefined(plannerLeaseId, "planner lease"),
      ];
      expect(new Set(heldLeases).size).toBe(3);
      expect(readAgentDatabaseLeaseIds(database.path, env)).toEqual(heldLeases.toSorted());
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
      closing = closeOpenClawAgentDatabaseByPathAsync(database.path);
      if (ending === "native-exit") {
        releaseAcknowledgement = undefined;
        await activeWorker!.terminate();
      } else {
        releaseAcknowledgement!();
        releaseAcknowledgement = undefined;
      }
      await expect(closing).resolves.toBe(true);
      const [result] = await reconciliation;
      expect(result).toEqual(
        ending === "native-exit"
          ? expect.objectContaining({ status: "rejected" })
          : { status: "fulfilled", value: { reconciledSessions: 1 } },
      );
      expect(events).toEqual(
        ending === "native-exit"
          ? ["release-task", "worker-release", "native-close"]
          : ["worker-release", "native-close"],
      );
      expect(database.db.isOpen).toBe(false);
      expect(leasesAtNativeClose).toEqual(nativeLeases);
      expect(readAgentDatabaseLeaseIds(database.path, env)).toEqual([]);
      const reopened = openOpenClawAgentDatabase(options);
      expect(
        reopened.db
          .prepare(
            "SELECT seq, event_json FROM transcript_events WHERE session_id = ? ORDER BY seq",
          )
          .all("settlement"),
      ).toEqual(original);
      if (ending === "complete") {
        const orphanRows = () => ({
          index: reopened.db
            .prepare(
              "SELECT count(*) AS count FROM session_transcript_index_state WHERE session_id = ?",
            )
            .get(orphanSessionId),
          identities: reopened.db
            .prepare(
              "SELECT count(*) AS count FROM session_transcript_fts_rows WHERE session_id = ?",
            )
            .get(orphanSessionId),
          content: reopened.db
            .prepare("SELECT count(*) AS count FROM session_transcript_fts WHERE session_id = ?")
            .get(orphanSessionId),
        });
        expect(orphanRows()).toEqual({
          index: { count: 1 },
          identities: { count: 1 },
          content: { count: 1 },
        });
        observer.onTask = undefined;
        await expect(reconcileSessionTranscriptIndexes(options)).resolves.toEqual({
          reconciledSessions: 0,
        });
        expect(orphanRows()).toEqual({
          index: { count: 0 },
          identities: { count: 0 },
          content: { count: 0 },
        });
      }
    } finally {
      canonical.restore();
      releaseAcknowledgement?.();
      await reconciliation;
      await closing?.catch(() => {});
      closeSpy?.mockRestore();
      await closeSessionTranscriptReconcileWorkerPool();
      await closeOpenClawAgentDatabasesAsync(stateDir);
      closeOpenClawStateDatabaseForTest();
    }
  },
);

it("revokes scheduled reconciliation before its first disk admission", async () => {
  const stateDir = tempDirs.make("openclaw-reconcile-delayed-admission-");
  const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
  const options = { agentId: "main", env };
  const resume = createDeferredCore();
  const runOperation = runSessionTranscriptReconcileOperation;
  const pool = await import("./session-transcript-reconcile-pool.js");
  let closing: Promise<boolean> | undefined;
  let completion: Promise<void> | undefined;
  try {
    await persistSessionTranscriptTurn(
      { ...options, sessionId: "delayed", sessionKey: "agent:main:delayed" },
      {
        messages: [{ eventId: "seed", message: { role: "user", content: "retained bytes" } }],
        touchSessionEntry: false,
      },
    );
    await waitForSessionTranscriptIndexReconcile(options);
    const database = openOpenClawAgentDatabase(options);
    database.db.prepare("UPDATE session_transcript_index_state SET needs_rebuild = 1").run();
    const task = vi.fn();
    observer.onTask = task;
    const operationSpy = vi.spyOn(pool, "runSessionTranscriptReconcileOperation");
    operationSpy.mockImplementationOnce((generation, run, owner) =>
      runOperation(
        generation,
        async (operation) => {
          await resume.promise;
          return run(operation);
        },
        owner,
      ),
    );
    startSessionTranscriptIndexReconcile(options);
    completion = waitForSessionTranscriptIndexReconcile(options);
    closing = closeOpenClawAgentDatabaseByPathAsync(database.path);
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
    await closeSessionTranscriptReconcileWorkerPool();
    await closeOpenClawAgentDatabasesAsync(stateDir);
    closeOpenClawStateDatabaseForTest();
  }
});
