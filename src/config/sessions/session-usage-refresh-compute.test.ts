import assert from "node:assert/strict";
import type { EventEmitter } from "node:events";
import { expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement } from "../../../test/helpers/promise.js";
import type { UsageCostWorkerInput } from "../../infra/session-cost-usage-worker.types.js";
import { WorkerTaskPool } from "../../infra/worker-task-pool.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { runOpenClawAgentWriteAdmission } from "../../state/openclaw-agent-write-admission.js";
import { costRefreshLane } from "./session-transcript-worker-resources.js";

type PostedTask = { input?: unknown; taskId?: number; responseId?: number };
type NativeWorker = EventEmitter & {
  postMessage: ReturnType<typeof vi.fn<(message: PostedTask) => void>>;
};
const native = vi.hoisted(() => ({
  workers: [] as NativeWorker[],
  observe: undefined as ((worker: NativeWorker, message: PostedTask) => void) | undefined,
}));

// One shared permit reproduces a saturated host compute budget deterministically.
vi.mock("../../infra/worker-task-capacity.js", async (importOriginal) => {
  const { createWorkerComputeCapacity } = await import("@openclaw/worker-runtime");
  const capacity = createWorkerComputeCapacity(1);
  return {
    ...(await importOriginal<typeof import("../../infra/worker-task-capacity.js")>()),
    getWorkerComputeCapacity: () => capacity,
  };
});
vi.mock("../../infra/runtime-worker-url.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/runtime-worker-url.js")>()),
  resolveRuntimeWorkerThreadExecArgv: () => [],
}));
vi.mock("../../infra/bun-sqlite-library.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/bun-sqlite-library.js")>()),
  ensureSqliteLibrarySelected: () => ({ source: "runtime" }),
}));
vi.mock("node:worker_threads", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:worker_threads")>();
  const { EventEmitter } = await import("node:events");
  return {
    ...actual,
    Worker: class extends EventEmitter {
      constructor() {
        super();
        native.workers.push(this as unknown as NativeWorker);
      }
      postMessage = vi.fn<(message: PostedTask) => void>((message) =>
        native.observe?.(this as unknown as NativeWorker, message),
      );
      ref() {}
      unref() {}
      async terminate() {
        this.emit("exit", 0);
        return 0;
      }
    },
  };
});

it("keeps usage refresh host writes out of writer-held reader compute capacity", async () => {
  const database = { agentId: "main", path: "/synthetic/usage-refresh-compute.sqlite" };
  const reader = new WorkerTaskPool<string, string>({
    workerUrl: new URL("file:///synthetic/writer-held-reader.js"),
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
      return "writer-held-rows";
    }, {});
    readSubmitted.resolve();
    return await reading;
  });
  const writerOutcome = Promise.allSettled([writing]);
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
    native.observe = (worker, message) => {
      if (message.input === request) {
        refreshPosted.resolve(worker);
      }
    };
    const refreshing = costRefreshLane.pool.run(request, {
      signal: controller.signal,
      async onRequest() {
        // Usage restores and rollups queue behind the agent writer that holds the reader.
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
      "Usage refresh did not reach its worker",
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
    // A refresh-held shared permit strands this dispatch behind its own queued host write.
    expect(readDispatched).toBe(true);
    const readerWorker = native.workers.find((candidate) =>
      candidate.postMessage.mock.calls.some(([message]) => message.input === "writer-held-rows"),
    );
    assert(readerWorker);
    const read = readerWorker.postMessage.mock.calls.find(
      ([message]) => message.input === "writer-held-rows",
    )?.[0];
    assert(read);
    readerWorker.emit("message", { status: "ok", taskId: read.taskId, value: "writer-held-rows" });
    await expect(writing).resolves.toBe("writer-held-rows");
    await expect(refreshing).resolves.toMatchObject({ ok: true });
    expect(hostWrites).toBe(1);
  } finally {
    controller.abort();
    startRead.resolve();
    await reader.close();
    await writerOutcome;
    await costRefreshLane.pool.rotate();
    await refreshOutcome;
    native.workers.length = 0;
    native.observe = undefined;
  }
});
