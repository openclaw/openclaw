import { setImmediate as checkpoint } from "node:timers/promises";
import type { Worker } from "node:worker_threads";
import { expect, it, vi } from "vitest";
import { createDeferred, withTestTimeout } from "../../../test/helpers/promise.js";
import { assertNoOpenClawAgentDatabaseLeases } from "../../state/openclaw-agent-db-lease.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../../state/openclaw-state-db.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../runtime-snapshot.js";
import { readSessionTranscriptMessageEvents } from "./session-accessor.js";
import { runExclusiveSqliteSessionWrite } from "./session-accessor.sqlite-scope.js";
import {
  markRebuild,
  projectionSnapshot,
  rows,
  seedTranscript,
  useReconcileTestRuntime,
} from "./session-transcript-reconcile.fixtures.test-support.js";
import {
  isSessionTranscriptIndexReconcileRunning,
  reconcileSessionTranscriptIndexes,
  startSessionTranscriptIndexReconcile,
  waitForSessionTranscriptIndexReconcile,
  waitForSessionTranscriptIndexReconcilesInStateDir,
} from "./session-transcript-reconcile.js";
import type { SessionTranscriptReconcileWorkerInput } from "./session-transcript-reconcile.worker.js";

vi.mock("node:worker_threads", async () =>
  (await import("./session-transcript-reconcile.test-support.js")).createObservedWorkerThreads(),
);

const { observer, tempDirs } = useReconcileTestRuntime();
const databaseOptions = { agentId: "main" };
const scope = {
  ...databaseOptions,
  sessionId: "native-exit-proof",
  sessionKey: "agent:main:native-exit-proof",
};
type ProjectionStage = "plan-start" | "active-chunk" | "fts-chunk" | "plan-finish" | "done";
const write = (run: () => Promise<void> = async () => undefined) =>
  runExclusiveSqliteSessionWrite(databaseOptions, run, "sessions.transcript-index.preflight");

function createQueuedProjectionFence(stage: ProjectionStage) {
  const release = createDeferred();
  const blocked = createDeferred();
  const acknowledged = createDeferred();
  let worker: Worker | undefined;
  let blocker: Promise<void> | undefined;
  let fenced = false;
  const modes: SessionTranscriptReconcileWorkerInput["mode"][] = [];
  observer.onTask = ({ input, worker: created, port, observeMessage }) => {
    modes.push(input.mode);
    if (input.mode === "disk") {
      worker = created;
    }
    const post = port.postMessage.bind(port);
    port.postMessage = (message: unknown, transferList) => {
      const options = Array.isArray(transferList) ? { transfer: transferList } : transferList;
      post(message, options);
      if (fenced) {
        acknowledged.resolve();
      }
    };
    // Both foreground writes and canonical publication enter this same per-path FIFO.
    observeMessage((message) => {
      if (message.type === stage && !fenced) {
        fenced = true;
        blocker = write(async () => {
          blocked.resolve();
          await release.promise;
        });
      }
    });
  };

  return {
    modes,
    blocked: blocked.promise,
    release: release.resolve,
    async terminate(): Promise<void> {
      if (!worker) {
        throw new Error("projection worker has not started");
      }
      await worker.terminate();
      expect(worker.threadId).toBe(-1);
    },
    async cleanup(): Promise<void> {
      release.resolve();
      await blocker;
      // On baseline failure, settlement can beat this handler; join it before fixture disposal.
      if (fenced && stage === "done") {
        await write();
      } else if (fenced) {
        await withTestTimeout(acknowledged.promise, 5_000, "queued projection did not finish");
      }
      await worker?.terminate();
    },
  };
}

const cases = (["plan-start", "active-chunk", "fts-chunk", "plan-finish", "done"] as const)
  .map((stage) => ({ stage, scheduled: false }))
  .concat([{ stage: "active-chunk", scheduled: true }]);

it.each(cases)(
  "joins queued $stage on native exit (scheduled=$scheduled)",
  async ({ stage, scheduled }) => {
    const stateDir = tempDirs.make("openclaw-native-worker-exit-");
    await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
      setRuntimeConfigSnapshot({});
      const fence = createQueuedProjectionFence(stage);
      let outcome: Promise<unknown> | undefined;
      let drain: Promise<void> | undefined;
      try {
        await seedTranscript(scope, "seed", "synthetic seed");
        const { db } = openOpenClawAgentDatabase(databaseOptions);
        markRebuild(db, scope.sessionId);
        const query = (sql: string) => rows(db, sql, scope.sessionId);
        const sourceRows = () =>
          query("SELECT seq, event_json FROM transcript_events WHERE session_id = ? ORDER BY seq");
        const snapshot = () => projectionSnapshot(db, scope.sessionId);
        const originalSource = sourceRows();
        let settled = false;
        if (scheduled) {
          startSessionTranscriptIndexReconcile(databaseOptions);
        }
        outcome = Promise.allSettled([
          scheduled
            ? waitForSessionTranscriptIndexReconcile(databaseOptions)
            : reconcileSessionTranscriptIndexes(databaseOptions),
        ]).then(([result]) => {
          settled = true;
          return result;
        });
        let drained = false;
        drain = waitForSessionTranscriptIndexReconcilesInStateDir(stateDir).then(() => {
          drained = true;
        });
        await withTestTimeout(fence.blocked, 10_000, "projection did not reach writer fence");
        await fence.terminate();
        await checkpoint();
        expect(settled).toBe(false);
        if (scheduled) {
          expect(drained).toBe(false);
          expect(isSessionTranscriptIndexReconcileRunning(databaseOptions)).toBe(true);
        }
        fence.release();
        const result = await outcome;
        expect(fence.modes).toEqual(["disk", "release"]);
        await drain;
        expect(result).toMatchObject({ status: scheduled ? "fulfilled" : "rejected" });
        expect(isSessionTranscriptIndexReconcileRunning(databaseOptions)).toBe(false);
        const atSettlement = snapshot();
        await write();
        await checkpoint();
        expect(snapshot()).toEqual(atSettlement);
        expect(sourceRows()).toEqual(originalSource);
        await reconcileSessionTranscriptIndexes(databaseOptions);
        expect(readSessionTranscriptMessageEvents(scope)).toMatchObject([
          { event: { id: "seed" } },
        ]);
        await fence.cleanup();
        await closeOpenClawAgentDatabasesAsync();
        closeOpenClawAgentDatabasesForTest();
        expect(() => assertNoOpenClawAgentDatabaseLeases(databaseOptions.agentId)).not.toThrow();
      } finally {
        await fence.cleanup();
        await outcome;
        await drain;
        await closeOpenClawAgentDatabasesAsync();
        closeOpenClawAgentDatabasesForTest();
        await closeOpenClawStateDatabaseAsync();
        closeOpenClawStateDatabaseForTest();
        clearRuntimeConfigSnapshot();
      }
    });
  },
  20_000,
);
