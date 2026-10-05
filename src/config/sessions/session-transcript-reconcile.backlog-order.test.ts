import { afterEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, withinTest } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  closeOpenClawAgentDatabasesAsync,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { persistSessionTranscriptTurn } from "./session-accessor.js";
import * as reconcilePool from "./session-transcript-reconcile-pool.js";
import {
  reconcileSessionTranscriptIndexes,
  waitForSessionTranscriptIndexReconcile,
  type SessionTranscriptReconcileResult,
} from "./session-transcript-reconcile.js";
import { useReconcileWorkerObserver } from "./session-transcript-reconcile.test-support.js";
import type { SessionTranscriptReconcileWorkerMessage } from "./session-transcript-reconcile.worker.js";

vi.mock("node:worker_threads", async () =>
  (await import("./session-transcript-reconcile.test-support.js")).createObservedWorkerThreads(),
);

const observer = useReconcileWorkerObserver();
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function seedPendingBacklogs(env: NodeJS.ProcessEnv, backlogs: Record<string, number>) {
  for (const [agentId, count] of Object.entries(backlogs)) {
    const options = { agentId, env };
    for (let index = 0; index < count; index++) {
      await persistSessionTranscriptTurn(
        { ...options, sessionId: `s${index}`, sessionKey: `agent:${agentId}:s${index}` },
        {
          messages: [{ eventId: `e${index}`, message: { role: "user", content: agentId } }],
          touchSessionEntry: false,
        },
      );
    }
    await waitForSessionTranscriptIndexReconcile(options);
    openOpenClawAgentDatabase(options)
      .db.prepare("UPDATE session_transcript_index_state SET needs_rebuild = 1")
      .run();
  }
  await reconcilePool.closeSessionTranscriptReconcileWorkerPool();
}

function expectIndexedBacklogs(env: NodeJS.ProcessEnv, backlogs: Record<string, number>) {
  for (const [agentId, count] of Object.entries(backlogs)) {
    const { db } = openOpenClawAgentDatabase({ agentId, env });
    expect(
      db
        .prepare(
          "SELECT session_id, needs_rebuild FROM session_transcript_index_state ORDER BY session_id",
        )
        .all(),
    ).toEqual(
      Array.from({ length: count }, (_, index) => ({
        session_id: `s${index}`,
        needs_rebuild: 0,
      })),
    );
    expect(
      db
        .prepare(
          "SELECT session_id, message_id, text FROM session_transcript_fts ORDER BY session_id",
        )
        .all(),
    ).toEqual(
      Array.from({ length: count }, (_, index) => ({
        session_id: `s${index}`,
        message_id: `e${index}`,
        text: agentId,
      })),
    );
  }
}

it("admits shorter backlogs at session boundaries and preserves a yielded agent's place", async ({
  signal,
}) => {
  const stateDir = tempDirs.make("openclaw-reconcile-backlog-order-");
  const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
  const backlogs = { "large-a": 4, "large-b": 3, small: 1 };
  const paused = createDeferredCore();
  const planStarts: string[] = [];
  const completed: string[] = [];
  const operations: Promise<SessionTranscriptReconcileResult>[] = [];
  let releaseAcknowledgement: (() => void) | undefined;
  let heldFirstFinish = false;
  try {
    await seedPendingBacklogs(env, backlogs);
    observer.onTask = ({ input, port, observeMessage }) => {
      if (input.mode !== "disk") {
        return;
      }
      observeMessage((message) => {
        if (message.type === "plan-start") {
          const agent = input.agentId.replace("large-", "");
          planStarts.push(`${agent}:${message.plan.sessionId}`);
        }
      });
      if (input.agentId !== "large-a" || heldFirstFinish) {
        return;
      }
      const on = port.on.bind(port);
      port.on = (event, listener) => {
        if (event !== "message") {
          return on(event, listener);
        }
        return on(event, (message: SessionTranscriptReconcileWorkerMessage) => {
          if (message.type === "plan-finish" && !heldFirstFinish) {
            heldFirstFinish = true;
            // Hold delivery before the parent computes the ACK's admission decision.
            releaseAcknowledgement = () => listener(message);
            paused.resolve();
            return;
          }
          listener(message);
        });
      };
    };
    const start = (agentId: string) => {
      const operation = reconcileSessionTranscriptIndexes({ agentId, env }).then((result) => {
        completed.push(agentId);
        return result;
      });
      operations.push(operation);
      void operation.catch(() => {});
      return operation;
    };
    const first = start("large-a");
    await withinTest(
      awaitGateBeforeSettlement(
        paused.promise,
        first,
        "large-a ended before its first plan-finish",
      ),
      signal,
    );
    void start("large-b");
    void start("small");
    await vi.waitFor(
      () => {
        expect(reconcilePool.getSessionTranscriptReconcileWorkerPoolSnapshot()).toMatchObject({
          workers: 1,
          activeTasks: 1,
          pendingTasks: 3,
        });
      },
      { timeout: 10_000 },
    );
    releaseAcknowledgement?.();
    releaseAcknowledgement = undefined;
    await expect(Promise.all(operations)).resolves.toEqual([
      { reconciledSessions: 4 },
      { reconciledSessions: 3 },
      { reconciledSessions: 1 },
    ]);
    expect(planStarts).toEqual([
      "a:s0",
      "small:s0",
      "a:s1",
      "a:s2",
      "a:s3",
      "b:s0",
      "b:s1",
      "b:s2",
    ]);
    expect(completed).toEqual(["small", "large-a", "large-b"]);
    expectIndexedBacklogs(env, backlogs);
    expect(reconcilePool.getSessionTranscriptReconcileWorkerPoolSnapshot()).toMatchObject({
      maxWorkers: 1,
      activeTasks: 0,
      pendingTasks: 0,
    });
  } finally {
    releaseAcknowledgement?.();
    await Promise.allSettled(operations);
    await reconcilePool.closeSessionTranscriptReconcileWorkerPool();
    await closeOpenClawAgentDatabasesAsync(stateDir);
    closeOpenClawStateDatabaseForTest();
  }
});

it.for(["database close", "caller cancellation"] as const)(
  "removes an admission waiter after %s without leaking the next agent's permit",
  async (reason, { signal }) => {
    const stateDir = tempDirs.make("openclaw-reconcile-backlog-abort-");
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    const paused = createDeferredCore();
    const plannedAgents: string[] = [];
    const operations: Promise<SessionTranscriptReconcileResult>[] = [];
    const controller = new AbortController();
    const requested = { revoked: createDeferredCore(), next: createDeferredCore() };
    let operationSpy: { mockRestore(): void } | undefined;
    let releaseAcknowledgement: (() => void) | undefined;
    let closing: Promise<boolean> | undefined;
    try {
      await seedPendingBacklogs(env, { active: 1, revoked: 1, next: 1 });
      const runOperation = reconcilePool.runSessionTranscriptReconcileOperation;
      operationSpy = vi
        .spyOn(reconcilePool, "runSessionTranscriptReconcileOperation")
        .mockImplementation(
          <T>(
            generation: number,
            run: (operation: reconcilePool.SessionTranscriptReconcileOperation) => Promise<T>,
            owner?: Parameters<typeof runOperation>[2],
            callerSignal?: AbortSignal,
          ) =>
            runOperation(
              generation,
              (operation) =>
                run({
                  ...operation,
                  startTask: (...args) => {
                    // The real call reserves synchronously before awaiting its permit.
                    const task = operation.startTask(...args);
                    const id = owner?.agentId;
                    if (args.length === 2 && (id === "revoked" || id === "next")) {
                      requested[id].resolve();
                    }
                    return task;
                  },
                }),
              owner,
              callerSignal,
            ),
        );
      const revokedDatabase = openOpenClawAgentDatabase({ agentId: "revoked", env });
      observer.onTask = ({ input, port, observeMessage }) => {
        if (input.mode !== "disk") {
          return;
        }
        let finishing = false;
        observeMessage((message) => {
          if (message.type === "plan-start") {
            plannedAgents.push(input.agentId);
          }
          finishing = message.type === "plan-finish";
        });
        if (input.agentId !== "active") {
          return;
        }
        const postMessage = port.postMessage.bind(port);
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
      const start = (agentId: string, callerSignal?: AbortSignal) => {
        const operation = reconcileSessionTranscriptIndexes({ agentId, env, signal: callerSignal });
        operations.push(operation);
        void operation.catch(() => {});
        return operation;
      };
      const active = start("active");
      await withinTest(
        awaitGateBeforeSettlement(
          paused.promise,
          active,
          "active agent ended before its plan-finish",
        ),
        signal,
      );
      const revoked = start("revoked", controller.signal);
      const next = start("next");
      await withinTest(
        awaitGateBeforeSettlement(
          Promise.all([requested.revoked.promise, requested.next.promise]),
          Promise.race([revoked, next]),
          "queued agent ended before requesting admission",
        ),
        signal,
      );
      expect(reconcilePool.getSessionTranscriptReconcileWorkerPoolSnapshot()).toMatchObject({
        activeTasks: 1,
        pendingTasks: 3,
      });
      if (reason === "database close") {
        closing = closeOpenClawAgentDatabaseByPathAsync(revokedDatabase.path);
      } else {
        controller.abort(new Error("startup maintenance owner retired"));
        expect(reconcilePool.getSessionTranscriptReconcileWorkerPoolSnapshot()).toMatchObject({
          activeTasks: 1,
          pendingTasks: 2,
        });
        releaseAcknowledgement?.();
        releaseAcknowledgement = undefined;
      }
      await withinTest(
        expect(revoked).rejects.toThrow(
          reason === "database close"
            ? "reconciliation was revoked"
            : "startup maintenance owner retired",
        ),
        signal,
      );
      if (closing) {
        await expect(closing).resolves.toBe(true);
        expect(reconcilePool.getSessionTranscriptReconcileWorkerPoolSnapshot()).toMatchObject({
          activeTasks: 1,
          pendingTasks: 2,
        });
      }
      releaseAcknowledgement?.();
      releaseAcknowledgement = undefined;
      await expect(Promise.all([active, next])).resolves.toEqual([
        { reconciledSessions: 1 },
        { reconciledSessions: 1 },
      ]);
      expect(plannedAgents).toEqual(["active", "next"]);
      expectIndexedBacklogs(env, { active: 1, next: 1 });
      expect(reconcilePool.getSessionTranscriptReconcileWorkerPoolSnapshot()).toMatchObject({
        maxWorkers: 1,
        activeTasks: 0,
        pendingTasks: 0,
      });
    } finally {
      releaseAcknowledgement?.();
      await Promise.allSettled(operations);
      await closing?.catch(() => {});
      operationSpy?.mockRestore();
      await reconcilePool.closeSessionTranscriptReconcileWorkerPool();
      await closeOpenClawAgentDatabasesAsync(stateDir);
      closeOpenClawStateDatabaseForTest();
    }
  },
);
