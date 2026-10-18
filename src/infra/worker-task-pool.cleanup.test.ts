import { AsyncLocalStorage } from "node:async_hooks";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import { WorkerTaskPool, type WorkerTaskResponse } from "./worker-task-pool.js";
import type { PoolFixtureInput, PoolFixtureResult } from "./worker-task-pool.test-support.js";

const cleanup = vi.hoisted(() => vi.fn<() => Promise<void>>());
vi.mock("./temp-artifact-cleanup.js", () => ({ removeTemporaryArtifacts: cleanup }));

const workerUrl = new URL("./worker-task-pool.test-support.ts", import.meta.url);

describe("worker task artifact lifetime", () => {
  it("retries failed idle retirement without releasing artifacts before native exit", async () => {
    const failure = new Error("mock termination did not complete");
    const terminate = vi
      .fn<() => Promise<number>>()
      .mockRejectedValueOnce(failure)
      .mockResolvedValue(0);
    let created = 0;
    class MockWorker extends EventEmitter {
      constructor() {
        super();
        created += 1;
      }
      ref() {}
      unref() {}
      terminate = terminate;
      postMessage(message: { taskId: number }) {
        queueMicrotask(() =>
          this.emit("message", { status: "ok", taskId: message.taskId, value: 42 }),
        );
      }
    }
    vi.doMock("node:worker_threads", async (importOriginal) => ({
      ...(await importOriginal<typeof import("node:worker_threads")>()),
      Worker: MockWorker,
    }));
    let retiring = false;
    vi.doMock("./temp-artifact-cleanup.js", () => {
      if (retiring) {
        throw new Error("cleanup module loaded during retirement");
      }
      return { removeTemporaryArtifacts: cleanup };
    });
    vi.resetModules();
    cleanup.mockReset();
    const cleanupOrder: string[] = [];
    cleanup.mockImplementation(async () => {
      await Promise.resolve();
      cleanupOrder.push("temporary-directory");
    });
    const releaseResources = vi.fn(async () => {
      await Promise.resolve();
      cleanupOrder.push("resources");
    });
    const { WorkerTaskPool: MockedWorkerTaskPool } = await import("./worker-task-pool.js");
    const observedCustody: number[][] = [];
    const onRetirementFailure = vi.fn(() => {
      observedCustody.push([cleanup.mock.calls.length, releaseResources.mock.calls.length]);
    });
    const pool = new MockedWorkerTaskPool<number, number>({
      workerUrl: new URL("file:///fixture/worker.js"),
      maxWorkers: 1,
      maxPendingTasks: 1,
      onRetirementFailure,
      prepareWorker: () => ({
        options: {},
        temporaryDirectory: "/fixture/worker-scratch",
        releaseResources,
      }),
    });
    try {
      await expect(pool.run(1, {})).resolves.toBe(42);
      retiring = true;
      expect(await Promise.allSettled([pool.close(), pool.close()])).toEqual([
        { status: "rejected", reason: failure },
        { status: "rejected", reason: failure },
      ]);
      expect(terminate).toHaveBeenCalledTimes(1);
      expect(onRetirementFailure).toHaveBeenCalledExactlyOnceWith(failure);
      expect(observedCustody).toEqual([[0, 0]]);
      expect(cleanup).not.toHaveBeenCalled();
      expect(releaseResources).not.toHaveBeenCalled();
      expect(created).toBe(1);
      await Promise.all([pool.close(), pool.close()]);
      expect(terminate).toHaveBeenCalledTimes(2);
      expect(onRetirementFailure).toHaveBeenCalledTimes(1);
      expect(created).toBe(1);
      expect(cleanup).toHaveBeenCalledExactlyOnceWith("/fixture/worker-scratch", "Worker task");
      expect(releaseResources).toHaveBeenCalledOnce();
      expect(cleanupOrder).toEqual(["temporary-directory", "resources"]);
    } finally {
      await pool.close().catch(() => undefined);
      cleanup.mockReset();
      vi.doUnmock("node:worker_threads");
      vi.doMock("./temp-artifact-cleanup.js", () => ({ removeTemporaryArtifacts: cleanup }));
      vi.resetModules();
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
      let responseScope: string | undefined;
      const responseConsumed = vi.fn(() => {
        responseScope = requestScope.getStore();
      });
      const queuedFactory = vi.fn(() => {
        expect(inputConsumed).toHaveBeenCalledTimes(1);
        expect(responseConsumed).toHaveBeenCalledTimes(1);
        expect(responseScope).toBe("request");
        return "next";
      });
      let created = 0;
      const terminate = vi
        .fn<() => Promise<number>>()
        .mockRejectedValueOnce(failure)
        .mockImplementationOnce(() => {
          retryEntered.resolve();
          return stopped.promise;
        })
        .mockResolvedValue(0);
      class MockWorker extends EventEmitter {
        constructor() {
          super();
          created += 1;
        }
        ref() {}
        unref() {}
        terminate = terminate;
        postMessage(message: { input: string; taskId: number; responseId?: number }) {
          expect(message.responseId).toBeUndefined();
          queueMicrotask(() => {
            this.emit(
              "message",
              message.input === "active"
                ? { status: "request", taskId: message.taskId, id: 1, value: "host" }
                : { status: "ok", taskId: message.taskId, value: message.input },
            );
          });
        }
      }
      vi.doMock("node:worker_threads", async (importOriginal) => ({
        ...(await importOriginal<typeof import("node:worker_threads")>()),
        Worker: MockWorker,
      }));
      vi.resetModules();
      cleanup.mockReset();
      cleanup.mockResolvedValue();
      const { WorkerTaskPool: MockedWorkerTaskPool } = await import("./worker-task-pool.js");
      const notified = vi.fn();
      const pool = new MockedWorkerTaskPool<string, string>({
        workerUrl: new URL("file:///fixture/worker.js"),
        maxWorkers: 1,
        maxPendingTasks: 2,
        onRetirementFailure: notified,
        prepareWorker: () => ({ options: {}, temporaryDirectory: "/fixture/scratch" }),
      });
      try {
        const controller = new AbortController();
        const active = requestScope.run("request", () =>
          pool.run("active", {
            signal: controller.signal,
            onInputConsumed: inputConsumed,
            onRequest: async () => {
              hostEntered.resolve();
              const response = await hostResponse.promise;
              hostReturned.resolve();
              return response;
            },
          }),
        );
        const failureAssertion = expect(active).rejects.toMatchObject({
          cause: failure,
          errors: [original, failure],
        });
        await hostEntered.promise;
        const rotation = pool.rotate();
        const next = pool.run(queuedFactory, {});
        const nextOutcome = next.then(
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
        expect(inputConsumed).not.toHaveBeenCalled();
        expect(responseConsumed).not.toHaveBeenCalled();
        expect(cleanup).not.toHaveBeenCalled();
        expect(queuedFactory).not.toHaveBeenCalled();
        expect(created).toBe(1);
        const closed = new Error("terminal pool close");
        const closing = closeDuringRotation ? pool.close(closed) : undefined;
        stopped.resolve(0);
        await Promise.all([rotation, closing]);
        expect(inputConsumed).toHaveBeenCalledTimes(1);
        expect(responseConsumed).toHaveBeenCalledTimes(1);
        expect(cleanup).toHaveBeenCalledExactlyOnceWith("/fixture/scratch", "Worker task");
        if (closeDuringRotation) {
          expect(await nextOutcome).toEqual({ error: closed });
          expect(queuedFactory).not.toHaveBeenCalled();
          expect(created).toBe(1);
          await expect(pool.run("later", {})).rejects.toBe(closed);
        } else {
          expect(await nextOutcome).toEqual({ value: "next" });
          expect(queuedFactory).toHaveBeenCalledTimes(1);
          expect(created).toBe(2);
        }
      } finally {
        stopped.resolve(0);
        await pool.close().catch(() => undefined);
        cleanup.mockReset();
        vi.doUnmock("node:worker_threads");
        vi.resetModules();
      }
    },
  );

  it("releases stopped execution before disposal while every close joins pending cleanup", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "worker-cleanup-owner-"));
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
    const roots: string[] = [];
    const pool = new WorkerTaskPool<PoolFixtureInput, PoolFixtureResult>({
      workerUrl,
      maxWorkers: 1,
      maxPendingTasks: 1,
      prepareWorker: () => {
        const owned = fs.mkdtempSync(path.join(directory, "generation-"));
        roots.push(owned);
        return { options: {}, temporaryDirectory: owned };
      },
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
      let taskSettled = false;
      void active
        .finally(() => {
          taskSettled = true;
        })
        .catch(() => {});
      await expect.poll(() => Atomics.load(new Int32Array(counters), 0)).toBe(1);
      context.run("request", () => controller.abort(new Error("canceled owner")));
      await entered.promise;
      expect(cleanupContext).toBeUndefined();
      await expect.poll(() => taskSettled).toBe(true);
      await expect(active).rejects.toThrow("canceled owner");
      await expect(pool.run({ label: "replacement" }, {})).resolves.toMatchObject({
        label: "replacement",
      });
      expect(new Set(roots).size).toBe(2);
      let closed = false;
      const closing = Promise.all([pool.close(), pool.close()]).then(() => {
        closed = true;
      });
      await expect.poll(() => cleanup.mock.calls.length).toBe(2);
      expect(closed).toBe(false);
      gate.resolve();
      await closing;
      expect(closed).toBe(true);
    } finally {
      gate.resolve();
      await pool.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
