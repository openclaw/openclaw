import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { execFile } from "node:child_process";
import { channel } from "node:diagnostics_channel";
import { once } from "node:events";
import fs from "node:fs";
import { availableParallelism } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createDeferredCore } from "../shared/deferred.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "./runtime-worker-url.js";
import { getTrackedWorkerCpuSources, getTrackedWorkerPoolSnapshot } from "./worker-cpu.js";
import { workerTaskPoolEntrypoints } from "./worker-task-pool-runtime.test-support.js";
import { WorkerTaskPool } from "./worker-task-pool.js";
import type { PoolFixtureInput, PoolFixtureResult } from "./worker-task-pool.test-support.js";

const workerUrl = resolveRuntimeWorkerUrl(workerTaskPoolEntrypoints.worker);
const pools: WorkerTaskPool<PoolFixtureInput, PoolFixtureResult>[] = [];
const workers = vi.hoisted(() => [] as Worker[]);
const directories = createTempDirTracker();

vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
  availableParallelism: () => 4,
}));

vi.mock("node:worker_threads", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:worker_threads")>();
  return {
    ...actual,
    Worker: class extends actual.Worker {
      constructor(...args: ConstructorParameters<typeof actual.Worker>) {
        super(...args);
        // Observe real workers even on runtimes without worker diagnostics events.
        workers.push(this);
      }
    },
  };
});

function createPool(
  options: ConstructorParameters<typeof WorkerTaskPool<PoolFixtureInput, PoolFixtureResult>>[0] = {
    workerUrl,
  },
) {
  const pool = new WorkerTaskPool<PoolFixtureInput, PoolFixtureResult>({
    maxWorkers: 1,
    ...options,
  });
  pools.push(pool);
  return pool;
}

afterEach(async () => {
  await Promise.all(pools.splice(0).map((pool) => pool.close()));
  for (const worker of workers.splice(0)) {
    expect(worker.threadId).toBe(-1);
  }
  directories.cleanup();
});

describe("worker task pool", () => {
  it("acknowledges input custody on its channel without a host exchange and reuses the healthy worker", async () => {
    const initial = getTrackedWorkerPoolSnapshot();
    const pool = createPool();
    const released = vi.fn();
    const onRequest = vi.fn(async () => {
      throw new Error("Consumption-only task must not request host work");
    });
    const first = await pool.run(
      { label: "closed", consumeInput: true },
      { onInputConsumed: released, onRequest },
    );
    expect(released).toHaveBeenCalledOnce();
    expect(onRequest).not.toHaveBeenCalled();
    const next = await pool.run({ label: "next" }, {});
    expect(next.threadId).toBe(first.threadId);
    expect(workers).toHaveLength(1);
    const warm = getTrackedWorkerPoolSnapshot();
    expect(warm.workerPoolCount).toBe(initial.workerPoolCount + 1);
    expect(warm.workerCount).toBe(initial.workerCount + 1);
    expect(warm.workerPools.at(-1)).toMatchObject({ workerCount: 1 });
    await pool.close();
    expect(getTrackedWorkerPoolSnapshot()).toEqual(initial);
  });

  it("rotates after active settlement and native exit while preserving queued order and deadlines", async () => {
    const initialCpuSources = getTrackedWorkerCpuSources();
    const pool = createPool();
    const counters = new Int32Array(new SharedArrayBuffer(8));
    const active = pool.run({ label: "active", counters: counters.buffer, wait: true }, {});
    await expect.poll(() => Atomics.load(counters, 0)).toBe(1);
    const oldWorker = workers.at(-1)!;
    const oldCpuSources = getTrackedWorkerCpuSources();
    expect(oldCpuSources.workers).toHaveLength(initialCpuSources.workers.length + 1);
    const order: string[] = [];
    const next = pool.run(() => {
      expect(oldWorker.threadId).toBe(-1);
      order.push("next");
      return { label: "next" };
    }, {});
    const expiring = pool.run({ label: "expired" }, { timeoutMs: 20 });
    const expiry = expect(expiring).rejects.toThrow("timed out");
    const rotation = pool.rotate();
    expect(pool.rotate()).toBe(rotation);
    const last = pool.run(() => {
      order.push("last");
      return { label: "last" };
    }, {});
    await expiry;
    expect(order).toEqual([]);
    Atomics.store(counters, 1, 1);
    Atomics.notify(counters, 1);
    const first = await active;
    await rotation;
    const results = await Promise.all([next, last]);
    expect(first.label).toBe("active");
    expect(results.map((result) => result.label)).toEqual(["next", "last"]);
    expect(results[0].threadId).not.toBe(first.threadId);
    expect(results[1].threadId).toBe(results[0].threadId);
    expect(order).toEqual(["next", "last"]);
    const newCpuSources = getTrackedWorkerCpuSources();
    expect(newCpuSources.workers).toHaveLength(oldCpuSources.workers.length);
    expect(newCpuSources.revision).toBeGreaterThan(oldCpuSources.revision);
    expect(newCpuSources.workers).not.toContain(oldCpuSources.workers.at(-1));
    await pool.close();
    expect(getTrackedWorkerCpuSources().workers).toEqual(initialCpuSources.workers);
  });

  it("never feeds canceled asynchronous preparation to a worker after rotation", async () => {
    const pool = createPool();
    const entered = createDeferredCore();
    const prepared = createDeferredCore();
    const controller = new AbortController();
    const active = pool.run(
      async () => {
        entered.resolve();
        await prepared.promise;
        return { label: "canceled" };
      },
      { signal: controller.signal },
    );
    await entered.promise;
    const rotation = pool.rotate();
    controller.abort(new Error("canceled preparation"));
    await expect(active).rejects.toThrow("canceled preparation");
    await rotation;
    await expect(pool.run({ label: "next" }, {})).resolves.toMatchObject({ label: "next" });
    prepared.resolve();
    await expect(pool.run({ label: "last" }, {})).resolves.toMatchObject({ label: "last" });
  });

  it("retains a failed retirement for retry without dispatching its queued successor", async () => {
    const pool = createPool();
    await pool.run({ label: "old" }, {});
    const oldWorker = workers.at(-1)!;
    const terminate = vi
      .spyOn(oldWorker, "terminate")
      .mockRejectedValueOnce(new Error("exit uncertain"));
    await expect(pool.rotate()).rejects.toThrow("exit uncertain");
    let dispatched = false;
    const next = pool.run(() => {
      dispatched = true;
      expect(oldWorker.threadId).toBe(-1);
      return { label: "next" };
    }, {});
    expect(dispatched).toBe(false);
    await pool.rotate();
    await expect(next).resolves.toMatchObject({ label: "next" });
    expect(terminate).toHaveBeenCalledTimes(2);
  });

  it("keeps terminal close terminal when it interrupts a graceful rotation", async () => {
    const pool = createPool();
    const counters = new Int32Array(new SharedArrayBuffer(8));
    const active = pool.run({ label: "active", counters: counters.buffer, wait: true }, {});
    await expect.poll(() => Atomics.load(counters, 0)).toBe(1);
    const rotation = pool.rotate();
    const queued = pool.run({ label: "queued" }, {});
    const activeFailure = expect(active).rejects.toThrow("pool closed");
    const queuedFailure = expect(queued).rejects.toThrow("pool closed");
    await Promise.all([pool.close(), rotation, activeFailure, queuedFailure]);
    await expect(pool.run({ label: "later" }, {})).rejects.toThrow("pool closed");
  });

  it.each(["factory", "options", "constructor"] as const)(
    "joins cancellation during worker %s preparation before removing scratch",
    async (phase) => {
      const directory = directories.make("worker-reentrant-preparation-");
      const controller = new AbortController();
      const reason = new Error("canceled during worker preparation");
      const createdBefore = workers.length;
      const workerChannel = channel("worker_threads");
      const cancel = () => controller.abort(reason);
      if (phase === "constructor") {
        workerChannel.subscribe(cancel);
      }
      const pool = createPool({
        workerUrl,
        workerOptions: {
          get workerData() {
            if (phase === "options") {
              cancel();
            }
            return { prepared: true };
          },
        },
        prepareWorker: () => {
          if (phase === "factory") {
            cancel();
          }
          return { options: {}, temporaryDirectory: directory };
        },
      });
      try {
        await expect(pool.run({ label: "canceled" }, { signal: controller.signal })).rejects.toBe(
          reason,
        );
        await pool.close();
        const created = workers.slice(createdBefore);
        expect(created).toHaveLength(phase === "constructor" ? 1 : 0);
        expect(created.map((worker) => worker.threadId)).toEqual(
          phase === "constructor" ? [-1] : [],
        );
        expect(fs.existsSync(directory)).toBe(false);
      } finally {
        workerChannel.unsubscribe(cancel);
        // A failed regression must still join any Worker created after cancellation.
        await Promise.all(workers.slice(createdBefore).map((worker) => worker.terminate()));
        await pool.close();
      }
    },
  );

  it.each([false, true])(
    "preserves static Worker options with prepared overrides: %s",
    async (prepared) => {
      const pool = createPool({
        workerUrl,
        workerOptions: {
          argv: ["shared-argument"],
          workerData: { source: "static", retained: true },
        },
        ...(prepared
          ? { prepareWorker: () => ({ options: { workerData: { source: "prepared" } } }) }
          : {}),
      });
      const result = await pool.run({ label: "options", readStartupOptions: true }, {});
      expect(result.startupOptions).toEqual({
        argv: ["shared-argument"],
        data: prepared ? { source: "prepared" } : { source: "static", retained: true },
      });
    },
  );

  it.each(["close", "abort", "exit", "startup-error", "clone-error"] as const)(
    "reclaims only its exited worker's scratch after %s",
    async (ending) => {
      const directory = directories.make("worker-owned-scratch-");
      const unrelated = directories.make("worker-unrelated-scratch-");
      fs.writeFileSync(path.join(directory, "captured-module.js"), "synthetic capture");
      fs.writeFileSync(path.join(unrelated, "retained-module.js"), "unrelated capture");
      const controller = new AbortController();
      const pool = createPool({
        workerUrl:
          ending === "startup-error" ? new URL("./missing-worker.mjs", import.meta.url) : workerUrl,
        restartOnError: false,
        prepareWorker: () => ({
          temporaryDirectory: directory,
          options: ending === "clone-error" ? { workerData: () => {} } : {},
        }),
      });
      if (ending === "startup-error" || ending === "clone-error") {
        await expect(pool.run({ label: ending }, {})).rejects.toMatchObject({
          code: "unavailable",
        });
      } else {
        await pool.run({ label: "warm" }, {});
        expect(fs.existsSync(directory)).toBe(true);
        const worker = workers.at(-1)!;
        if (ending === "close") {
          await pool.close();
        } else if (ending === "exit") {
          await worker.terminate();
          await pool.close();
        } else {
          const counters = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2);
          const active = pool.run(
            { label: "blocked", counters, wait: true },
            { signal: controller.signal },
          );
          void active.catch(() => {});
          await expect.poll(() => Atomics.load(new Int32Array(counters), 0)).toBe(1);
          expect(fs.existsSync(directory)).toBe(true);
          controller.abort(new Error("scratch canceled"));
          await expect(active).rejects.toThrow("scratch canceled");
        }
        expect(worker.threadId).toBe(-1);
      }
      await pool.close();
      expect(fs.existsSync(directory)).toBe(false);
      expect(fs.readFileSync(path.join(unrelated, "retained-module.js"), "utf8")).toBe(
        "unrelated capture",
      );
    },
  );
  it("keeps canceled preparation charged until its retained input is released", async () => {
    const pool = createPool({ workerUrl, maxPendingTasks: 1 });
    const gate = createDeferredCore<PoolFixtureInput>();
    const controller = new AbortController();
    const executionSettled = vi.fn();
    const disposed = createDeferredCore();
    const first = pool.run(() => gate.promise, {
      signal: controller.signal,
      onExecutionSettled: executionSettled,
      onInputConsumed: disposed.resolve,
    });
    const settled = Promise.allSettled([first]);
    controller.abort();
    await settled;
    expect(executionSettled).toHaveBeenCalledExactlyOnceWith({ retired: true });
    await expect(pool.run({ label: "excess" }, {})).rejects.toMatchObject({ code: "overloaded" });
    gate.resolve({ label: "canceled" });
    await disposed.promise;
    expect(pool.getSnapshot().pendingTasks).toBe(0);
    expect(executionSettled).toHaveBeenCalledOnce();
    expect(await pool.run({ label: "recovered" }, {})).toMatchObject({ label: "recovered" });
  });

  it("keeps a shared worker healthy when an input factory rejects before dispatch", async () => {
    const pool = createPool({
      workerUrl,
      restartOnError: false,
      idleTimeoutMs: 0,
      maxPendingTasks: 2,
      maxPendingBytes: 16,
    });
    const first = await pool.run({ label: "first" }, {});
    const input = createDeferredCore<PoolFixtureInput>();
    const reason = new Error("queued catalog owner superseded");
    const released = vi.fn();
    const rejected = pool.run(() => input.promise, {
      inputBytes: 8,
      onInputConsumed: released,
    });
    const sibling = pool.run({ label: "sibling" }, { inputBytes: 8 });
    const settled = Promise.allSettled([rejected, sibling]);
    input.reject(reason);

    expect(await settled).toEqual([
      { status: "rejected", reason },
      {
        status: "fulfilled",
        value: expect.objectContaining({ label: "sibling", threadId: first.threadId }),
      },
    ]);
    expect(released).toHaveBeenCalledOnce();
    await expect(pool.run({ label: "later" }, { inputBytes: 16 })).resolves.toMatchObject({
      label: "later",
      threadId: first.threadId,
    });
    expect(pool.getSnapshot()).toMatchObject({
      workers: 1,
      workersCreated: 1,
      activeTasks: 0,
      pendingTasks: 0,
    });
  });

  it.each(["tasks", "bytes"] as const)(
    "rejects excess pending %s and releases rejected inputs in caller context",
    async (bound) => {
      const context = new AsyncLocalStorage<string>();
      const pool = createPool({
        workerUrl,
        maxPendingTasks: bound === "tasks" ? 2 : 10,
        maxPendingBytes: 8,
      });
      const ready = createDeferredCore<PoolFixtureInput>();
      const first = pool.run(() => ready.promise, { inputBytes: 4 });
      const queued = pool.run({ label: "queued" }, { inputBytes: 4 });
      const released: Array<string | undefined> = [];
      let prepared = false;
      const excess = context.run("rejected owner", () =>
        pool.run(
          () => {
            prepared = true;
            return { label: "excess" };
          },
          {
            inputBytes: bound === "bytes" ? 1 : 0,
            onInputConsumed: () => released.push(context.getStore()),
          },
        ),
      );
      const settled = Promise.allSettled([first, queued, excess]);
      ready.resolve({ label: "first" });
      const results = await settled;
      expect(results[2]).toMatchObject({ status: "rejected", reason: { code: "overloaded" } });
      expect(prepared).toBe(false);
      expect(released).toEqual(["rejected owner"]);
      expect(await pool.run({ label: "recovered" }, { inputBytes: 8 })).toMatchObject({
        label: "recovered",
      });
    },
  );

  it("shares compute capacity across pools while ordered workers remain independent", async () => {
    const initial = getTrackedWorkerPoolSnapshot();
    const limit = Math.max(1, availableParallelism() - 1);
    const owner = createPool({ workerUrl, sharedCompute: true, maxWorkers: limit });
    const waiting = createPool({ workerUrl, sharedCompute: true });
    const independent = createPool();
    const gate = createDeferredCore<PoolFixtureInput>();
    const running = Array.from({ length: limit }, () => owner.run(() => gate.promise, {}));
    let prepared = false;
    const queued = waiting.run(() => {
      prepared = true;
      return { label: "waiting" };
    }, {});
    const settled = Promise.allSettled([...running, queued]);
    try {
      expect(prepared).toBe(false);
      expect(await independent.run({ label: "ordered" }, {})).toMatchObject({ label: "ordered" });
      expect(prepared).toBe(false);
    } finally {
      gate.resolve({ label: "owner" });
      await settled;
    }
    expect(await queued).toMatchObject({ label: "waiting" });
    const census = getTrackedWorkerPoolSnapshot();
    expect(census.workerPoolCount).toBe(initial.workerPoolCount + 3);
    expect(census.workerCount).toBe(initial.workerCount + limit + 2);
    expect(census.workerPools.map((pool) => pool.workerCount)).toEqual([limit, 1, 1]);
  });

  it.each(["before", "during"] as const)(
    "requests a host checkpoint for contention %s the exchange",
    async (contention) => {
      const context = new AsyncLocalStorage<string>();
      let checkpointContext: string | undefined;
      const limit = Math.max(1, availableParallelism() - 1);
      const owner = createPool({ workerUrl, sharedCompute: true, maxWorkers: limit });
      const waiting = createPool({ workerUrl, sharedCompute: true });
      const gate = createDeferredCore<PoolFixtureInput>();
      const entered = createDeferredCore();
      const checkpoint = createDeferredCore();
      let checkpointRequested = false;
      const blockers = Array.from({ length: limit - 1 }, () => owner.run(() => gate.promise, {}));
      const host = context.run("host owner", () =>
        owner.run(
          { label: "host", exchanges: 1 },
          {
            onRequest: async (_input, { yieldSignal }) => {
              entered.resolve();
              const requestCheckpoint = () => {
                checkpointContext = context.getStore();
                checkpointRequested = true;
                checkpoint.resolve();
              };
              if (yieldSignal.aborted) {
                requestCheckpoint();
              } else {
                yieldSignal.addEventListener("abort", requestCheckpoint, { once: true });
              }
              await checkpoint.promise;
              return { input: null, timeoutMs: 10_000 };
            },
          },
        ),
      );
      const settled = Promise.allSettled([...blockers, host]);
      if (contention === "during") {
        await entered.promise;
      }
      const next = context.run("contender", () => waiting.run({ label: "next" }, {}));
      try {
        await expect.poll(() => checkpointRequested).toBe(true);
        expect(checkpointContext).toBe("host owner");
        expect(await next).toMatchObject({ label: "next" });
      } finally {
        checkpoint.resolve();
        gate.resolve({ label: "blocker" });
        await Promise.allSettled([settled, next]);
      }
    },
  );

  it("moves worker-owned host request bytes out of the worker", async () => {
    const pool = createPool();
    let transferred: ArrayBuffer | undefined;
    const result = await pool.run(
      { label: "request bytes", exchanges: 2, relayBuffer: true },
      {
        timeoutMs: 10_000,
        onRequest: async (value) => {
          const request = value as { buffer?: ArrayBuffer };
          if (request.buffer) {
            transferred = request.buffer;
            return { input: null, timeoutMs: 10_000 };
          }
          const bytes = new ArrayBuffer(1024 * 1024);
          new Uint8Array(bytes).set([31, 47]);
          return { input: bytes, transferList: [bytes], timeoutMs: 10_000 };
        },
      },
    );
    expect(result.relayedBufferBytes).toBe(0);
    expect(transferred?.byteLength).toBe(1024 * 1024);
    expect(new Uint8Array(transferred!).slice(0, 2)).toEqual(new Uint8Array([31, 47]));
  });

  it("transfers owned host reply bytes without retaining a copy in the parent", async () => {
    const pool = createPool();
    const bytes = new ArrayBuffer(1024 * 1024);
    new Uint8Array(bytes).set([17, 29, 43]);
    const result = await pool.run(
      { label: "host bytes", exchanges: 1 },
      {
        timeoutMs: 10_000,
        onRequest: async () => ({ input: bytes, transferList: [bytes], timeoutMs: 10_000 }),
      },
    );
    expect(bytes.byteLength).toBe(0);
    expect(result.buffer?.byteLength).toBe(1024 * 1024);
    expect(new Uint8Array(result.buffer!).slice(0, 3)).toEqual(new Uint8Array([17, 29, 43]));
  });

  it.each(["abort", "close"] as const)(
    "keeps host cancellation callbacks in the admitted caller context on %s",
    async (ending) => {
      const context = new AsyncLocalStorage<string>();
      const pool = createPool();
      const entered = createDeferredCore();
      const abort = new AbortController();
      const observed: Array<string | undefined> = [];
      const run = context.run("owner", () =>
        pool.run(
          { label: "cancel", exchanges: 1 },
          {
            timeoutMs: 10000,
            signal: abort.signal,
            onRequest: async (_value, { signal }) => {
              entered.resolve();
              return await new Promise((_, reject) => {
                signal.addEventListener(
                  "abort",
                  () => {
                    observed.push(context.getStore());
                    reject(new Error("closed"));
                  },
                  { once: true },
                );
              });
            },
          },
        ),
      );
      const result = Promise.allSettled([run]);
      await entered.promise;
      await context.run("unrelated caller", async () => {
        if (ending === "abort") {
          abort.abort();
        } else {
          await pool.close();
        }
      });
      expect((await result)[0]?.status).toBe("rejected");
      expect(observed).toEqual(["owner"]);
    },
  );

  it("keeps each queued and reused task's caller context through preparation and host exchanges", async () => {
    const context = new AsyncLocalStorage<string>();
    const pool = createPool();
    const observed: Array<{ owner: string; stage: string; actual: string | undefined }> = [];
    const submit = (owner: string) =>
      context.run(owner, () =>
        pool.run(
          () => {
            observed.push({ owner, stage: "prepare", actual: context.getStore() });
            return { label: owner, exchanges: 2 };
          },
          {
            timeoutMs: 10000,
            onInputConsumed: () => {
              observed.push({ owner, stage: "initial receipt", actual: context.getStore() });
            },
            onRequest: async () => {
              observed.push({ owner, stage: "request", actual: context.getStore() });
              await Promise.resolve();
              return {
                input: null,
                timeoutMs: 10000,
                onConsumed: () => {
                  observed.push({ owner, stage: "reply receipt", actual: context.getStore() });
                },
              };
            },
          },
        ),
      );
    const [first, queued] = await Promise.all([submit("first"), submit("queued")]);
    const reused = await submit("reused");
    expect(first.threadId).toBe(queued.threadId);
    expect(reused.threadId).toBe(first.threadId);
    expect(observed).toHaveLength(18);
    for (const item of observed) {
      expect(item.actual, item.stage + ":" + item.owner).toBe(item.owner);
    }
  });

  it("bounds parallel execution and reuses warm workers for queued requests", async () => {
    const pool = createPool({ workerUrl, maxWorkers: 2 });
    const counters = new SharedArrayBuffer(8);
    const view = new Int32Array(counters);
    const completion = Promise.all(
      ["first", "second", "third"].map((label) =>
        pool.run({ label, counters, wait: true }, { timeoutMs: 10_000 }),
      ),
    );
    void completion.catch(() => {});
    try {
      await expect.poll(() => Atomics.load(view, 0)).toBe(2);
      expect(workers).toHaveLength(2);
      Atomics.store(view, 1, 1);
      Atomics.notify(view, 1);
      const results = await completion;
      expect(results.map((result) => result.label)).toEqual(["first", "second", "third"]);
      expect(new Set(results.map((result) => result.threadId)).size).toBe(2);
      expect(Atomics.load(view, 0)).toBe(3);
      expect((await pool.run({ label: "warm" }, { timeoutMs: 10_000 })).threadId).toBe(
        results[0]?.threadId,
      );
      expect(workers).toHaveLength(2);
    } finally {
      Atomics.store(view, 1, 1);
      Atomics.notify(view, 1);
      await Promise.allSettled([completion]);
    }
  });

  it.each(["complete", "abort", "close"] as const)(
    "keeps tasks without a deadline pending until %s",
    async (ending) => {
      const pool = createPool();
      const counters = new SharedArrayBuffer(8);
      const view = new Int32Array(counters);
      const controller = new AbortController();
      const reason = new Error(`explicit ${ending}`);
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const active = pool.run(
        { label: "active", counters, wait: true },
        ending === "abort" ? { signal: controller.signal } : {},
      );
      const queued = pool.run({ label: "queued" }, {});
      const settled = Promise.allSettled([active, queued]);
      try {
        // Omission must not install the pool's historical 60-second default timer.
        await vi.advanceTimersByTimeAsync(60_001);
        if (ending === "abort") {
          controller.abort(reason);
        } else if (ending === "close") {
          await pool.close(reason);
        } else {
          Atomics.store(view, 1, 1);
          Atomics.notify(view, 1);
        }
        const outcomes = await settled;
        expect(outcomes[0]).toEqual(
          ending === "complete"
            ? { status: "fulfilled", value: expect.objectContaining({ label: "active" }) }
            : { status: "rejected", reason },
        );
        expect(outcomes[1]).toEqual(
          ending === "close"
            ? { status: "rejected", reason }
            : { status: "fulfilled", value: expect.objectContaining({ label: "queued" }) },
        );
      } finally {
        Atomics.store(view, 1, 1);
        Atomics.notify(view, 1);
        await pool.close();
        await settled;
        vi.useRealTimers();
      }
    },
  );

  it("expires queued work and never launches cancelled asynchronous preparation", async () => {
    const pool = createPool();
    const counters = new SharedArrayBuffer(8);
    const view = new Int32Array(counters);
    const controller = new AbortController();
    const reason = new Error("cancel prepared task");
    let prepared!: (input: PoolFixtureInput) => void;
    const preparing = pool.run(
      () =>
        new Promise<PoolFixtureInput>((resolve) => {
          prepared = resolve;
        }),
      { timeoutMs: 10_000, signal: controller.signal },
    );
    const rejected = expect(preparing).rejects.toBe(reason);
    const queuedFactory = vi.fn(() => ({ label: "expired", counters }));
    await expect(pool.run(queuedFactory, { timeoutMs: 10 })).rejects.toMatchObject({
      code: "timeout",
    });
    expect(queuedFactory).not.toHaveBeenCalled();
    controller.abort(reason);
    await rejected;
    prepared({ label: "abandoned", counters });
    await expect(
      pool.run({ label: "current", counters }, { timeoutMs: 10_000 }),
    ).resolves.toMatchObject({ label: "current" });
    expect(Atomics.load(view, 0)).toBe(1);
    expect(workers).toHaveLength(1);
  });

  it.each(["abort", "deadline"] as const)(
    "terminates the running worker on %s before admitting its replacement",
    async (ending) => {
      const pool = createPool();
      const counters = new SharedArrayBuffer(8);
      const controller = new AbortController();
      const reason = new Error("cancel execution");
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const active = pool.run(
        { label: "cancelled", counters, wait: true },
        { timeoutMs: 10_000, signal: controller.signal },
      );
      const rejected =
        ending === "abort"
          ? expect(active).rejects.toBe(reason)
          : expect(active).rejects.toMatchObject({ code: "timeout" });
      try {
        await expect.poll(() => Atomics.load(new Int32Array(counters), 0)).toBe(1);
        const cancelledWorker = workers[0];
        const replacement = pool.run({ label: "replacement" }, {});
        if (ending === "abort") {
          controller.abort(reason);
        } else {
          await vi.advanceTimersByTimeAsync(10_000);
        }
        await rejected;
        expect(cancelledWorker?.threadId).toBe(-1);
        await expect(replacement).resolves.toMatchObject({ label: "replacement" });
        expect(workers).toHaveLength(2);
      } finally {
        await pool.close();
        vi.useRealTimers();
      }
    },
  );

  it("rejects a clean exit before a response and recovers capacity", async () => {
    const pool = createPool();
    await expect(
      pool.run({ label: "exit", exitCode: 0 }, { timeoutMs: 10_000 }),
    ).rejects.toMatchObject({ code: "unavailable" });
    await expect(pool.run({ label: "next" }, { timeoutMs: 10_000 })).resolves.toMatchObject({
      label: "next",
    });
    expect(workers).toHaveLength(2);
  });

  it("closes a generation before a rejected result can dispatch its successor", async () => {
    const reason = new Error("generation superseded");
    const pool = createPool({
      workerUrl,
      restartOnError: false,
      validateResult: () => {
        throw reason;
      },
    });
    const first = pool.run({ label: "stale" }, { timeoutMs: 10_000 });
    const nextFactory = vi.fn(() => ({ label: "forbidden" }));
    const next = pool.run(nextFactory, { timeoutMs: 10_000 });
    await Promise.all([expect(first).rejects.toBe(reason), expect(next).rejects.toBe(reason)]);
    await expect(pool.run({ label: "closed" }, { timeoutMs: 10_000 })).rejects.toBe(reason);
    expect(nextFactory).not.toHaveBeenCalled();
    expect(workers).toHaveLength(1);
    expect(workers[0]?.threadId).toBe(-1);
  });

  it("does not recreate an idle generation worker after it crashes", async () => {
    const pool = createPool({ workerUrl, restartOnError: false, idleTimeoutMs: 0 });
    await pool.run({ label: "generation" }, { timeoutMs: 10_000 });
    const worker = workers[0];
    assert.ok(worker);
    await worker.terminate();
    await expect(pool.run({ label: "forbidden" }, { timeoutMs: 10_000 })).rejects.toMatchObject({
      code: "unavailable",
    });
    expect(workers).toHaveLength(1);
  });

  it("retires idle compute workers and transfers uniquely owned buffers in both directions", async () => {
    const pool = createPool({ workerUrl, idleTimeoutMs: 20 });
    const buffer = new ArrayBuffer(4);
    new Uint8Array(buffer)[0] = 42;
    const result = await pool.run(
      { label: "transfer", buffer },
      { timeoutMs: 10_000, transferList: (input) => [input.buffer!] },
    );
    expect(buffer.byteLength).toBe(0);
    expect(new Uint8Array(result.buffer!)[0]).toBe(42);
    expect((await pool.run({ label: "inspect" }, { timeoutMs: 10_000 })).previousBufferBytes).toBe(
      0,
    );
    await expect.poll(() => workers[0]?.threadId).toBe(-1);
    const next = await pool.run({ label: "new worker" }, { timeoutMs: 10_000 });
    expect(next.threadId).not.toBe(result.threadId);
  });

  it("arms idle retirement on the clock the pool was created under", async () => {
    const pool = createPool({ workerUrl, idleTimeoutMs: 20 });
    await pool.run({ label: "warm" }, { timeoutMs: 10_000 });
    // Process-wide pools finish work on worker messages, which can arrive inside an
    // unrelated test's fake-timer window; that clock must not receive the idle timer.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      await pool.run({ label: "under a fake clock" }, {});
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
    const worker = workers.at(-1);
    assert.ok(worker);
    await expect.poll(() => worker.threadId).toBe(-1);
  });

  it("keeps a promptly recreated worker warm across intermittent tasks, then expires it", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const pool = createPool();
    try {
      await pool.run({ label: "cold" }, {});
      const coldExit = once(workers.at(-1)!, "exit");
      await vi.advanceTimersByTimeAsync(70_000);
      await coldExit;
      const warm = await pool.run({ label: "hot script" }, {});
      for (let index = 0; index < 8; index++) {
        await vi.advanceTimersByTimeAsync(70_000);
        const next = await pool.run({ label: "intermittent" }, {});
        expect(next.threadId).toBe(warm.threadId);
      }
      expect(pool.getSnapshot().workersCreated).toBe(2);
      const warmExit = once(workers.at(-1)!, "exit");
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      await warmExit;
      expect(pool.getSnapshot().workers).toBe(0);
    } finally {
      await pool.close();
      vi.useRealTimers();
    }
  });

  it("lets a headless process exit while warm workers are idle", async () => {
    const { stdout } = await promisify(execFile)(
      process.execPath,
      resolveRuntimeWorkerArgv(resolveRuntimeWorkerUrl(workerTaskPoolEntrypoints.headless)),
      { timeout: 15_000 },
    );
    expect(stdout.trim()).toBe("finished");
  }, 20_000);

  it.each([
    {
      name: "releases parent inputs while their worker copies are still executing",
      entrypoint: workerTaskPoolEntrypoints.inputRetention,
    },
    {
      name: "releases delivered replies while their worker remains warm",
      entrypoint: workerTaskPoolEntrypoints.replyRetention,
    },
  ])(
    "$name",
    async ({ entrypoint }) => {
      await promisify(execFile)(
        process.execPath,
        ["--expose-gc", ...resolveRuntimeWorkerArgv(resolveRuntimeWorkerUrl(entrypoint))],
        { timeout: 20_000 },
      );
    },
    25_000,
  );
});
