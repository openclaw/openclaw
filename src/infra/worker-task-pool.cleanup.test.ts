import { AsyncLocalStorage } from "node:async_hooks";
import { EventEmitter } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import { WorkerTaskPool, type WorkerTaskResponse } from "./worker-task-pool.js";
import { expectCalls } from "./worker-task-pool.owned.test-support.js";
import type { PoolFixtureInput, PoolFixtureResult } from "./worker-task-pool.test-support.js";

const cleanup = vi.hoisted(() => vi.fn<() => Promise<void>>());
vi.mock("./temp-artifact-cleanup.js", () => ({ removeTemporaryArtifacts: cleanup }));

const workerUrl = new URL("./worker-task-pool.test-support.ts", import.meta.url);
const temporaryDirectory = "/fixture/scratch";

afterEach(() => {
  cleanup.mockReset();
  vi.doUnmock("node:worker_threads");
  vi.doMock("./temp-artifact-cleanup.js", () => ({ removeTemporaryArtifacts: cleanup }));
  vi.resetModules();
});

type TaskMessage = { taskId: number; input: string; responseId?: number };
const defaultReply = ({ taskId }: TaskMessage) => ({ status: "ok", taskId, value: 42 });

async function mockWorker(
  terminate: () => Promise<number>,
  respond: (message: TaskMessage) => unknown = defaultReply,
) {
  const created = vi.fn();
  class MockWorker extends EventEmitter {
    constructor() {
      super();
      created();
    }
    ref() {}
    unref() {}
    terminate = terminate;
    postMessage(message: TaskMessage) {
      const response = respond(message);
      queueMicrotask(() => this.emit("message", response));
    }
  }
  vi.doMock("node:worker_threads", async (importOriginal) => ({
    ...(await importOriginal<typeof import("node:worker_threads")>()),
    Worker: MockWorker,
  }));
  vi.resetModules();
  cleanup.mockReset();
  return { created, Pool: (await import("./worker-task-pool.js")).WorkerTaskPool };
}

it("retries failed idle retirement without releasing artifacts before native exit", async () => {
  const failure = new Error("mock termination did not complete");
  const terminate = vi.fn<() => Promise<number>>().mockResolvedValue(0);
  terminate.mockRejectedValueOnce(failure);
  const loadCleanup = vi.fn(() => ({ removeTemporaryArtifacts: cleanup }));
  // mock-isolation: Observe lazy cleanup loading without deleting fixture artifacts.
  vi.doMock("./temp-artifact-cleanup.js", loadCleanup);
  const { created, Pool } = await mockWorker(terminate);
  const cleanupOrder: string[] = [];
  async function recordCleanup(label: string) {
    await Promise.resolve();
    cleanupOrder.push(label);
  }
  cleanup.mockImplementation(() => recordCleanup("temporary-directory"));
  const releaseResources = vi.fn(() => recordCleanup("resources"));
  const observedCustody: number[][] = [];
  const onRetirementFailure = vi.fn(() => {
    observedCustody.push([cleanup.mock.calls.length, releaseResources.mock.calls.length]);
  });
  const pool = new Pool<number, number>({
    workerUrl: new URL("file:///fixture/worker.js"),
    maxWorkers: 1,
    onRetirementFailure,
    prepareWorker: () => ({ options: {}, temporaryDirectory, releaseResources }),
  });
  try {
    await expect(pool.run(1, {})).resolves.toBe(42);
    loadCleanup.mockImplementation(() => {
      throw new Error("cleanup module loaded during retirement");
    });
    expect(await Promise.allSettled([pool.close(), pool.close()])).toEqual(
      Array.from({ length: 2 }, () => ({ status: "rejected", reason: failure })),
    );
    expectCalls(1, terminate, created);
    expect(onRetirementFailure).toHaveBeenCalledExactlyOnceWith(failure);
    expect(observedCustody).toEqual([[0, 0]]);
    expectCalls(0, cleanup, releaseResources);
    await Promise.all([pool.close(), pool.close()]);
    expectCalls(2, terminate);
    expectCalls(1, onRetirementFailure, created, releaseResources);
    expect(cleanup).toHaveBeenCalledExactlyOnceWith(temporaryDirectory, "Worker task");
    expect(cleanupOrder).toEqual(["temporary-directory", "resources"]);
  } finally {
    await pool.close().catch(() => undefined);
  }
});

it.each([false, true])(
  "retains active rotation custody through a failed stop and late host response (close=%s)",
  async (closeDuringRotation) => {
    const original = new Error("original task canceled");
    const failure = new Error("mock native stop failed");
    const hostEntered = createDeferredCore();
    const hostReturned = createDeferredCore();
    const hostResponse = createDeferredCore<WorkerTaskResponse>();
    const retryEntered = createDeferredCore();
    const stopped = createDeferredCore<number>();
    const requestScope = new AsyncLocalStorage<string>();
    const inputConsumed = vi.fn();
    const responseConsumed = vi.fn(() => requestScope.getStore());
    const queuedFactory = vi.fn(() => {
      expectCalls(1, inputConsumed, responseConsumed);
      expect(responseConsumed.mock.results[0]?.value).toBe("request");
      return "next";
    });
    const terminate = vi.fn<() => Promise<number>>().mockResolvedValue(0);
    terminate.mockRejectedValueOnce(failure).mockImplementationOnce(() => {
      retryEntered.resolve();
      return stopped.promise;
    });
    const { created, Pool } = await mockWorker(terminate, (message) => {
      expect(message.responseId).toBeUndefined();
      return message.input === "active"
        ? { status: "request", taskId: message.taskId, id: 1, value: "host" }
        : { status: "ok", taskId: message.taskId, value: message.input };
    });
    cleanup.mockResolvedValue();
    const notified = vi.fn();
    const pool = new Pool<string, string>({
      workerUrl: new URL("file:///fixture/worker.js"),
      maxWorkers: 1,
      maxPendingTasks: 2,
      onRetirementFailure: notified,
      prepareWorker: () => ({ options: {}, temporaryDirectory }),
    });
    try {
      const controller = new AbortController();
      const active = requestScope.run("request", () =>
        pool.run("active", {
          signal: controller.signal,
          onInputConsumed: inputConsumed,
          onRequest: () => {
            hostEntered.resolve();
            return hostResponse.promise.finally(hostReturned.resolve);
          },
        }),
      );
      const failureAssertion = expect(active).rejects.toMatchObject({
        cause: failure,
        errors: [original, failure],
      });
      await hostEntered.promise;
      const rotation = pool.rotate();
      const nextOutcome = pool.run(queuedFactory, {}).then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      controller.abort(original);
      await failureAssertion;
      await retryEntered.promise;
      expect(notified).toHaveBeenCalledExactlyOnceWith(failure);
      await expect(pool.run("capacity remains owned", {})).rejects.toMatchObject({
        code: "overloaded",
      });
      hostResponse.resolve({
        input: "must not be sent",
        timeoutMs: 1000,
        onConsumed: responseConsumed,
      });
      await hostReturned.promise;
      expectCalls(0, inputConsumed, responseConsumed, cleanup, queuedFactory);
      expectCalls(1, created);
      const closed = new Error("terminal pool close");
      const closing = closeDuringRotation ? pool.close(closed) : undefined;
      stopped.resolve(0);
      await Promise.all([rotation, closing]);
      expectCalls(1, inputConsumed, responseConsumed);
      expect(cleanup).toHaveBeenCalledExactlyOnceWith(temporaryDirectory, "Worker task");
      expect(await nextOutcome).toEqual(
        closeDuringRotation ? { error: closed } : { value: "next" },
      );
      expectCalls(closeDuringRotation ? 0 : 1, queuedFactory);
      expectCalls(closeDuringRotation ? 1 : 2, created);
      if (closeDuringRotation) {
        await expect(pool.run("later", {})).rejects.toBe(closed);
      }
    } finally {
      stopped.resolve(0);
      await pool.close().catch(() => undefined);
    }
  },
);

it("releases stopped execution before disposal while every close joins pending cleanup", async () => {
  const gate = createDeferredCore();
  const entered = createDeferredCore();
  const context = new AsyncLocalStorage<string>();
  let cleanupContext: string | undefined;
  cleanup
    .mockImplementationOnce(() => {
      cleanupContext = context.getStore();
      entered.resolve();
      return gate.promise;
    })
    .mockResolvedValue(undefined);
  let generations = 0;
  const pool = new WorkerTaskPool<PoolFixtureInput, PoolFixtureResult>({
    workerUrl,
    maxWorkers: 1,
    maxPendingTasks: 1,
    prepareWorker: () => ({ options: {}, temporaryDirectory: `/fixture/${++generations}` }),
  });
  try {
    await expect(
      context.run("request", () => pool.run({ label: "warm" }, {})),
    ).resolves.toMatchObject({ label: "warm" });
    const controller = new AbortController();
    const counters = new SharedArrayBuffer(8);
    const active = context.run("request", () =>
      pool.run({ label: "held", counters, wait: true }, { signal: controller.signal }),
    );
    const settled = expect(active).rejects.toThrow("canceled owner");
    await expect.poll(() => Atomics.load(new Int32Array(counters), 0)).toBe(1);
    context.run("request", () => controller.abort(new Error("canceled owner")));
    await entered.promise;
    expect(cleanupContext).toBeUndefined();
    await settled;
    await expect(pool.run({ label: "replacement" }, {})).resolves.toMatchObject({
      label: "replacement",
    });
    expect(generations).toBe(2);
    const closed = vi.fn();
    const closing = Promise.all([pool.close(), pool.close()]).then(closed);
    await expect.poll(() => cleanup.mock.calls.length).toBe(2);
    expectCalls(0, closed);
    gate.resolve();
    await closing;
    expectCalls(1, closed);
  } finally {
    gate.resolve();
    await pool.close();
  }
});
