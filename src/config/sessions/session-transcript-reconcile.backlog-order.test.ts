import { afterEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, withinTest } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
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

it("gives another agent a turn at a session boundary without a priority queue", async ({
  signal,
}) => {
  const stateDir = tempDirs.make("openclaw-reconcile-backlog-order-");
  const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
  const backlogs = { "large-a": 4, "large-b": 3, small: 1 };
  const paused = createDeferredCore();
  const planStarts: string[] = [];
  const completed: string[] = [];
  const operations: Promise<SessionTranscriptReconcileResult>[] = [];
  const queued = createDeferredCore();
  const queuedAgents = new Set<string>();
  let operationSpy: { mockRestore(): void } | undefined;
  let releaseAcknowledgement: (() => void) | undefined;
  let heldFirstFinish = false;
  try {
    await seedPendingBacklogs(env, backlogs);
    const runOperation = reconcilePool.runSessionTranscriptReconcileOperation;
    operationSpy = vi
      .spyOn(reconcilePool, "runSessionTranscriptReconcileOperation")
      .mockImplementation((run, owner, callerSignal) =>
        runOperation(
          (operation) =>
            run({
              ...operation,
              startTask: (input) => {
                const task = operation.startTask(input);
                if (input.mode === "disk" && owner && owner.agentId !== "large-a") {
                  queuedAgents.add(owner.agentId);
                  if (queuedAgents.size === 2) {
                    queued.resolve();
                  }
                }
                return task;
              },
            }),
          owner,
          callerSignal,
        ),
      );
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
    void start("small");
    void start("large-b");
    await withinTest(queued.promise, signal);
    releaseAcknowledgement?.();
    releaseAcknowledgement = undefined;
    await expect(Promise.all(operations)).resolves.toEqual([
      { reconciledSessions: 4 },
      { reconciledSessions: 1 },
      { reconciledSessions: 3 },
    ]);
    expect(planStarts[0]).toBe("a:s0");
    expect(planStarts.indexOf("small:s0")).toBeLessThan(planStarts.indexOf("a:s3"));
    expect(planStarts.indexOf("small:s0")).toBeLessThan(planStarts.indexOf("b:s2"));
    expect(completed[0]).toBe("small");
    expectIndexedBacklogs(env, backlogs);
    expect(reconcilePool.getSessionTranscriptReconcileWorkerPoolSnapshot()).toMatchObject({
      maxWorkers: 1,
      activeTasks: 0,
      pendingTasks: 0,
    });
  } finally {
    operationSpy?.mockRestore();
    releaseAcknowledgement?.();
    await Promise.allSettled(operations);
    await reconcilePool.closeSessionTranscriptReconcileWorkerPool();
    await closeOpenClawAgentDatabasesAsync(stateDir);
    closeOpenClawStateDatabaseForTest();
  }
});
