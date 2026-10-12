// Register shared worker mocks before modules that consume them.
// oxfmt-ignore
import { input, nativePosts, nativeWorkers, observed, type NativeWorker } from "./session-transcript-worker-lanes.test-support.js";
import assert from "node:assert/strict";
import { expect, it } from "vitest";
import { awaitGateBeforeSettlement } from "../../../test/helpers/promise.js";
import type { UsageCostWorkerInput } from "../../infra/session-cost-usage-worker.types.js";
import { WorkerTaskPool } from "../../infra/worker-task-pool.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { runQueuedStoreWrite } from "../../shared/store-writer-queue.js";
import {
  runOpenClawAgentWorkerWrite,
  runOpenClawAgentWriteAdmission,
} from "../../state/openclaw-agent-write-admission.js";
import { costRefreshLane, projectionLane } from "./session-transcript-worker-resources.js";
import { withSessionHistoryWorkerDatabase } from "./session-transcript-worker-runtime.js";

it("keeps usage refresh host writes out of writer-held reader compute capacity", async () => {
  const { database } = input();
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
  let readDispatched = false;
  let hostWrites = 0;
  const writing = runOpenClawAgentWriteAdmission(database, async () => {
    held.resolve();
    await startRead.promise;
    const reading = reader.run(() => {
      readDispatched = true;
      return "origin-rows";
    }, {});
    readSubmitted.resolve();
    return await reading;
  });
  const writerOutcome = Promise.allSettled([writing]);
  let refreshing: ReturnType<typeof costRefreshLane.pool.run> | undefined;
  let refreshOutcome: Promise<unknown> | undefined;
  try {
    await held.promise;
    const request: UsageCostWorkerInput = {
      kind: "usage-cost",
      location: {
        agentId: database.agentId,
        databasePath: database.path,
        storePath: database.path,
        env: {},
      },
      databases: [database],
      operation: { kind: "refresh", pricingFingerprint: "synthetic" },
    };
    nativePosts.observe = (worker, message) => {
      if (message.input === request) {
        refreshPosted.resolve(worker);
      }
    };
    refreshing = costRefreshLane.pool.run(request, {
      signal: controller.signal,
      async onRequest() {
        const restoring = runOpenClawAgentWriteAdmission(database, () => {
          hostWrites++;
        });
        hostRequested.resolve();
        await restoring;
        return { input: undefined, timeoutMs: 1_000 };
      },
    });
    refreshOutcome = Promise.allSettled([refreshing]);
    const worker = await awaitGateBeforeSettlement(
      refreshPosted.promise,
      refreshing,
      "Usage refresh did not finish worker preparation",
    );
    const task = worker.postMessage.mock.calls.find(([message]) => message.input === request)?.[0];
    assert(task);
    worker.postMessage.mockImplementation((message) => {
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
    await awaitGateBeforeSettlement(
      hostRequested.promise,
      refreshing,
      "Usage refresh did not request its host writer",
    );
    expect(hostWrites).toBe(0);
    startRead.resolve();
    await readSubmitted.promise;
    // The old refresh permit strands this dispatch behind its own queued host write.
    expect(readDispatched).toBe(true);
    const readerWorker = nativeWorkers.find((candidate) =>
      candidate.postMessage.mock.calls.some(([message]) => message.input === "origin-rows"),
    );
    assert(readerWorker);
    const read = readerWorker.postMessage.mock.calls.find(
      ([message]) => message.input === "origin-rows",
    )?.[0];
    assert(read);
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
      status = runOpenClawAgentWorkerWrite(
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
    await awaitGateBeforeSettlement(entered.promise, search, "Cold search lost its writer context");
    await expect(search).resolves.toEqual({ hits: [] });
  } finally {
    releaseOnFailure.resolve(false);
    await Promise.allSettled([search]);
    await status;
  }
});
