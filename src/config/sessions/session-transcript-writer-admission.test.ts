// Register shared worker mocks before modules that consume them.
// oxfmt-ignore
import { input, nativePosts, nativeWorkers, observed, type NativeWorker } from "./session-transcript-worker-lanes.test-support.js";
import assert from "node:assert/strict";
import { expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement as waitFor } from "../../../test/helpers/promise.js";
import type { UsageCostWorkerInput } from "../../infra/session-cost-usage-worker.types.js";
import { WorkerTaskPool } from "../../infra/worker-task-pool.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { runQueuedStoreWrite } from "../../shared/store-writer-queue.js";
import {
  runOpenClawAgentWorkerWrite as workerWrite,
  runOpenClawAgentWriteAdmission as withWriter,
} from "../../state/openclaw-agent-write-admission.js";
import { costRefreshLane, projectionLane } from "./session-transcript-worker-resources.js";
import { withSessionHistoryWorkerDatabase } from "./session-transcript-worker-runtime.js";

it("keeps usage refresh host writes out of writer-held reader compute capacity", async () => {
  const { database } = input();
  const { agentId, path: databasePath } = database;
  const reader = new WorkerTaskPool<string, string>({
    workerUrl: new URL("file:///synthetic/memory-origin-reader.js"),
    sharedCompute: true,
    maxWorkers: 1,
    idleTimeoutMs: 0,
  });
  const held = createDeferredCore();
  const startRead = createDeferredCore();
  const readSubmitted = createDeferredCore();
  const hostRequested = createDeferredCore();
  const refreshPosted = createDeferredCore<NativeWorker>();
  const controller = new AbortController();
  const prepareRead = vi.fn(() => "origin-rows");
  let hostWrites = 0;
  const writing = withWriter(database, async () => {
    held.resolve();
    await startRead.promise;
    const reading = reader.run(prepareRead, {});
    readSubmitted.resolve();
    return await reading;
  });
  const writerOutcome = Promise.allSettled([writing]);
  let refreshOutcome: Promise<unknown> | undefined;
  try {
    await held.promise;
    const request: UsageCostWorkerInput = {
      kind: "usage-cost",
      location: { agentId, databasePath, storePath: databasePath, env: {} },
      databases: [database],
      archiveStorePaths: [database.path],
      stores: [{ agentId: database.agentId, storePath: database.path, database }],
      operation: { kind: "refresh", pricingFingerprint: "synthetic" },
    };
    nativePosts.observe = (worker, message) => {
      if (message.input === request) {
        refreshPosted.resolve(worker);
      }
    };
    const refreshing = costRefreshLane.pool.run(request, {
      signal: controller.signal,
      async onRequest() {
        const restoring = withWriter(database, () => {
          hostWrites++;
        });
        hostRequested.resolve();
        await restoring;
        return { input: undefined, timeoutMs: 1_000 };
      },
    });
    refreshOutcome = Promise.allSettled([refreshing]);
    await waitFor(refreshPosted.promise, refreshing, "Usage worker preparation");
    const [worker, task] = postedTask(request);
    worker.posted.mockImplementation((message) => {
      if (message.responseId !== undefined) {
        queueMicrotask(() => {
          worker.emit("message", {
            status: "consumed",
            taskId: task.taskId,
            id: message.responseId,
          });
          worker.emit("message", {
            status: "ok",
            taskId: task.taskId,
            value: { ok: true, value: { kind: "refresh", changed: false }, closedDatabases: [] },
          });
        });
      }
    });
    worker.emit("message", { status: "request", taskId: task.taskId, id: 1, value: "restore" });
    await waitFor(hostRequested.promise, refreshing, "Usage host writer request");
    expect(hostWrites).toBe(0);
    startRead.resolve();
    await readSubmitted.promise;
    // The old refresh permit strands this dispatch behind its own queued host write.
    expect(prepareRead).toHaveBeenCalledOnce();
    const [readerWorker, read] = postedTask("origin-rows");
    readerWorker.emit("message", { status: "ok", taskId: read.taskId, value: "origin-rows" });
    await expect(writing).resolves.toBe("origin-rows");
    await expect(refreshing).resolves.toMatchObject({ ok: true });
    expect(hostWrites).toBe(1);
  } finally {
    controller.abort();
    startRead.resolve();
    await reader.close();
    await writerOutcome;
    await costRefreshLane.pool.rotate();
    await refreshOutcome;
    nativeWorkers.length = 0;
    nativePosts.observe = undefined;
  }
});

function postedTask(request: unknown): [NativeWorker, Parameters<NativeWorker["postMessage"]>[0]] {
  for (const worker of nativeWorkers) {
    const task = worker.posted.mock.calls.find(([message]) => message.input === request)?.[0];
    if (task) {
      return [worker, task];
    }
  }
  throw new Error("Expected a posted native task");
}

it("allows reader cleanup while only a logical session lock is held", async () => {
  const { database } = input();
  await runQueuedStoreWrite({
    queues: new Map(),
    storePath: database.path,
    label: "logical session lock",
    fn: async () => {
      await projectionLane.pool.closeResources(database.path);
      await projectionLane.pool.rotate();
    },
  });
  expect(observed.closeResources).toHaveBeenCalledOnce();
  expect(observed.rotate).toHaveBeenCalledOnce();
});

it("lets a cold search host write reenter its reserved discovery admission", async () => {
  observed.preparedDatabase = false;
  const { database } = input();
  const entered = createDeferredCore();
  const releaseOnFailure = createDeferredCore<boolean>();
  let status: Promise<boolean> | undefined;
  observed.run.mockImplementation(async (_input, options) => {
    assert(options.onRequest);
    const response = await options.onRequest("transcript-index-status", {
      signal: new AbortController().signal,
      yieldSignal: new AbortController().signal,
    });
    expect(response.input).toBe(false);
    return { ok: true, value: { kind: "transcript-search", result: { hits: [] } } };
  });
  const search = withSessionHistoryWorkerDatabase(database, (owner) =>
    owner.searchTranscripts({ agentId: "main", query: "needle" }, (signal) => {
      status = workerWrite(
        database,
        async () => {
          entered.resolve();
          return false;
        },
        undefined,
        signal,
      );
      return Promise.race([status, releaseOnFailure.promise]);
    }),
  );
  try {
    await waitFor(entered.promise, search, "Cold search writer admission");
    await expect(search).resolves.toEqual({ hits: [] });
  } finally {
    releaseOnFailure.resolve(false);
    await Promise.allSettled([search]);
    await status;
  }
});
