import type { Worker } from "node:worker_threads";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { drainGlobalSingletonLifecycleState } from "../../shared/global-singleton.js";
import {
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

function countAgentDatabaseLeases(pathname: string, env: NodeJS.ProcessEnv): number {
  return openOpenClawStateDatabase({ env })
    .db.prepare("SELECT lease_id FROM agent_database_leases WHERE owner_pid = ? AND path = ?")
    .all(process.pid, pathname).length;
}

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
        openOpenClawAgentDatabase(options)
          .db.prepare("UPDATE session_transcript_index_state SET needs_rebuild = 1")
          .run();
      }
      await closeSessionTranscriptReconcileWorkerPool();
      observer.onTask = ({ input, worker, port, observeMessage }) => {
        modes.push(input.mode);
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
      expect(countAgentDatabaseLeases(openOpenClawAgentDatabase(targets[0]!).path, env)).toBe(2);
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
      for (const options of targets.slice(0, 2)) {
        const database = openOpenClawAgentDatabase(options);
        expect(countAgentDatabaseLeases(database.path, env)).toBe(1);
        expect(
          database.db.prepare("SELECT message_id, text FROM session_transcript_fts").all(),
        ).toEqual([{ message_id: options.agentId, text: options.agentId }]);
      }
      const late = vi.fn(async () => undefined);
      for (const captured of [generation, duringClose]) {
        await expect(runSessionTranscriptReconcileOperation(captured, late)).rejects.toThrow(
          "lifecycle is closed",
        );
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
      releaseAcknowledgement?.();
      await operations;
      await closeSessionTranscriptReconcileWorkerPool();
      await closeOpenClawAgentDatabasesAsync(stateDir);
      closeOpenClawStateDatabaseForTest();
    }
  },
  30_000,
);
