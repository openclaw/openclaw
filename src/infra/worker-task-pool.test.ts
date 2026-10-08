import { AsyncLocalStorage } from "node:async_hooks";
import { execFile } from "node:child_process";
import { channel } from "node:diagnostics_channel";
import fs from "node:fs";
import { availableParallelism } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import type { Worker } from "node:worker_threads";
import { afterEach, expect, it, vi } from "vitest";
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
const exec = promisify(execFile);
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
        workers.push(this);
      }
    },
  };
});
function createPool(
  options: Partial<
    ConstructorParameters<typeof WorkerTaskPool<PoolFixtureInput, PoolFixtureResult>>[0]
  > = {},
) {
  const pool = new WorkerTaskPool<PoolFixtureInput, PoolFixtureResult>({
    workerUrl,
    maxWorkers: 1,
    ...options,
  });
  pools.push(pool);
  return pool;
}
afterEach(async () => {
  await Promise.all(pools.splice(0).map((pool) => pool.close()));
  vi.useRealTimers();
  for (const worker of workers.splice(0)) {
    expect(worker.threadId).toBe(-1);
  }
  directories.cleanup();
});

it("rotates after native exit while preserving queued order, deadlines, and CPU tracking", async () => {
  const initial = getTrackedWorkerCpuSources();
  const pool = createPool();
  const counters = new Int32Array(new SharedArrayBuffer(8));
  const active = pool.run({ label: "active", counters: counters.buffer, wait: true }, {});
  await expect.poll(() => Atomics.load(counters, 0)).toBe(1);
  const oldWorker = workers.at(-1)!;
  const oldSources = getTrackedWorkerCpuSources();
  expect(oldSources.workers).toHaveLength(initial.workers.length + 1);
  const order: string[] = [];
  const next = pool.run(() => {
    expect(oldWorker.threadId).toBe(-1);
    order.push("next");
    return { label: "next" };
  }, {});
  const expiry = expect(pool.run({ label: "expired" }, { timeoutMs: 20 })).rejects.toThrow(
    "timed out",
  );
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
  const current = getTrackedWorkerCpuSources();
  expect(current.workers).toHaveLength(oldSources.workers.length);
  expect(current.revision).toBeGreaterThan(oldSources.revision);
  expect(current.workers).not.toContain(oldSources.workers.at(-1));
  await pool.close();
  expect(getTrackedWorkerCpuSources().workers).toEqual(initial.workers);
});

it.each(["options", "constructor"] as const)(
  "joins cancellation during %s before removing scratch",
  async (phase) => {
    const directory = directories.make("worker-reentrant-preparation-");
    const controller = new AbortController();
    const reason = new Error("canceled during worker preparation");
    const workerChannel = channel("worker_threads");
    const cancel = () => controller.abort(reason);
    if (phase === "constructor") {
      workerChannel.subscribe(cancel);
    }
    const pool = createPool({
      workerOptions: {
        get workerData() {
          if (phase === "options") {
            cancel();
          }
          return { prepared: true };
        },
      },
      prepareWorker: () => ({ options: {}, temporaryDirectory: directory }),
    });
    try {
      await expect(pool.run({ label: "canceled" }, { signal: controller.signal })).rejects.toBe(
        reason,
      );
      await pool.close();
      expect(workers.map((worker) => worker.threadId)).toEqual(phase === "constructor" ? [-1] : []);
      expect(fs.existsSync(directory)).toBe(false);
    } finally {
      workerChannel.unsubscribe(cancel);
      // Join even a Worker incorrectly created after reentrant cancellation.
      await Promise.all(workers.map((worker) => worker.terminate()));
      await pool.close();
    }
  },
);

it("reclaims only its worker scratch after startup failure", async () => {
  const directory = directories.make("worker-owned-scratch-");
  const unrelated = directories.make("worker-unrelated-scratch-");
  fs.writeFileSync(path.join(directory, "captured-module.js"), "synthetic capture");
  fs.writeFileSync(path.join(unrelated, "retained-module.js"), "unrelated capture");
  const pool = createPool({
    workerUrl: new URL("./missing-worker.mjs", import.meta.url),
    restartOnError: false,
    prepareWorker: () => ({ temporaryDirectory: directory, options: {} }),
  });
  await expect(pool.run({ label: "startup-error" }, {})).rejects.toMatchObject({
    code: "unavailable",
  });
  await pool.close();
  expect(fs.existsSync(directory)).toBe(false);
  expect(fs.readFileSync(path.join(unrelated, "retained-module.js"), "utf8")).toBe(
    "unrelated capture",
  );
});

it("shares compute capacity across pools while ordered workers remain independent", async () => {
  const initial = getTrackedWorkerPoolSnapshot();
  const limit = Math.max(1, availableParallelism() - 1);
  const owner = createPool({ sharedCompute: true, maxWorkers: limit });
  const waiting = createPool({ sharedCompute: true });
  const independent = createPool();
  const gate = createDeferredCore<PoolFixtureInput>();
  const running = Array.from({ length: limit }, () => owner.run(() => gate.promise, {}));
  const prepare = vi.fn(() => ({ label: "waiting" }));
  const queued = waiting.run(prepare, {});
  const settled = Promise.allSettled([...running, queued]);
  try {
    expect(prepare).not.toHaveBeenCalled();
    expect(await independent.run({ label: "ordered" }, {})).toMatchObject({ label: "ordered" });
    expect(prepare).not.toHaveBeenCalled();
  } finally {
    gate.resolve({ label: "owner" });
    await settled;
  }
  expect(await queued).toMatchObject({ label: "waiting" });
  const census = getTrackedWorkerPoolSnapshot();
  expect(census.workerPoolCount).toBe(initial.workerPoolCount + 3);
  expect(census.workerCount).toBe(initial.workerCount + limit + 2);
  expect(census.workerPools.map((pool) => pool.workerCount)).toEqual([limit, 1, 1]);
  await Promise.all([owner.close(), waiting.close(), independent.close()]);
  expect(getTrackedWorkerPoolSnapshot()).toEqual(initial);
});

it("requests a host checkpoint when compute contention arrives during an exchange", async () => {
  const context = new AsyncLocalStorage<string>();
  const limit = Math.max(1, availableParallelism() - 1);
  const owner = createPool({ sharedCompute: true, maxWorkers: limit });
  const waiting = createPool({ sharedCompute: true });
  const gate = createDeferredCore<PoolFixtureInput>();
  const entered = createDeferredCore();
  const checkpoint = createDeferredCore();
  let checkpointRequested = false;
  let checkpointContext: string | undefined;
  const blockers = Array.from({ length: limit - 1 }, () => owner.run(() => gate.promise, {}));
  const host = context.run("host owner", () =>
    owner.run(
      { label: "host", exchanges: 1 },
      {
        onRequest: async (_input, { yieldSignal }) => {
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
          entered.resolve();
          await checkpoint.promise;
          return { input: null, timeoutMs: 10_000 };
        },
      },
    ),
  );
  const settled = Promise.allSettled([...blockers, host]);
  await entered.promise;
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
});

it("keeps host cancellation callbacks in the admitted caller context", async () => {
  const context = new AsyncLocalStorage<string>();
  const pool = createPool();
  const entered = createDeferredCore();
  const abort = new AbortController();
  const observed = vi.fn(() => context.getStore());
  const run = context.run("owner", () =>
    pool.run(
      { label: "cancel", exchanges: 1 },
      {
        signal: abort.signal,
        onRequest: async (_value, { signal }) => {
          entered.resolve();
          return await new Promise((_, reject) => {
            signal.addEventListener(
              "abort",
              () => {
                observed();
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
  context.run("unrelated caller", () => abort.abort());
  expect((await result)[0]?.status).toBe("rejected");
  expect(observed).toHaveBeenCalledOnce();
  expect(observed.mock.results[0]?.value).toBe("owner");
});

it("keeps queued and reused tasks in their caller context through preparation and exchanges", async () => {
  const context = new AsyncLocalStorage<string>();
  const pool = createPool();
  const observed: string[] = [];
  const submit = (owner: string) =>
    context.run(owner, () => {
      const record = (stage: string) => {
        expect(context.getStore(), `${owner}:${stage}`).toBe(owner);
        observed.push(stage);
      };
      return pool.run(
        () => {
          record("prepare");
          return { label: owner, exchanges: 2 };
        },
        {
          onInputConsumed: () => record("initial receipt"),
          onRequest: async () => {
            record("request");
            await Promise.resolve();
            return { input: null, timeoutMs: 10_000, onConsumed: () => record("reply receipt") };
          },
        },
      );
    });
  const [first, queued] = await Promise.all([submit("first"), submit("queued")]);
  const reused = await submit("reused");
  expect(first.threadId).toBe(queued.threadId);
  expect(reused.threadId).toBe(first.threadId);
  expect(observed).toHaveLength(18);
});

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
    restartOnError: false,
    validateResult: () => {
      throw reason;
    },
  });
  const first = pool.run({ label: "stale" }, {});
  const nextFactory = vi.fn(() => ({ label: "forbidden" }));
  const next = pool.run(nextFactory, {});
  await Promise.all([expect(first).rejects.toBe(reason), expect(next).rejects.toBe(reason)]);
  await expect(pool.run({ label: "closed" }, {})).rejects.toBe(reason);
  expect(nextFactory).not.toHaveBeenCalled();
  expect(workers).toHaveLength(1);
  expect(workers[0]?.threadId).toBe(-1);
});

it("arms idle retirement on the clock the pool was created under", async () => {
  const pool = createPool({ idleTimeoutMs: 20 });
  await pool.run({ label: "warm" }, {});
  // Replies can arrive inside an unrelated test's fake-clock window.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  await pool.run({ label: "under a fake clock" }, {});
  expect(vi.getTimerCount()).toBe(0);
  vi.useRealTimers();
  await expect.poll(() => workers.at(-1)!.threadId).toBe(-1);
});

it.each([
  {
    name: "releases parent inputs while worker copies execute",
    entrypoint: workerTaskPoolEntrypoints.inputRetention,
  },
  {
    name: "releases delivered replies while their worker remains warm",
    entrypoint: workerTaskPoolEntrypoints.replyRetention,
  },
])(
  "$name",
  async ({ entrypoint }) => {
    await exec(
      process.execPath,
      ["--expose-gc", ...resolveRuntimeWorkerArgv(resolveRuntimeWorkerUrl(entrypoint))],
      { timeout: 20_000 },
    );
  },
  25_000,
);

it("keeps import-only dependency exports when a source worker requires compiled ESM", async () => {
  const directory = directories.make("worker-import-only-");
  fs.writeFileSync(path.join(directory, "package.json"), '{"type":"module"}');
  const dependency = path.join(directory, "node_modules", "import-only-fixture");
  fs.mkdirSync(dependency, { recursive: true });
  fs.writeFileSync(
    path.join(dependency, "package.json"),
    JSON.stringify({ type: "module", exports: { node: { import: "./index.js" } } }),
  );
  fs.writeFileSync(path.join(dependency, "index.js"), "export const marker = 37;");
  fs.writeFileSync(
    path.join(directory, "bridge.js"),
    'export { marker } from "import-only-fixture";',
  );
  const workerPath = path.join(directory, "worker.ts");
  fs.writeFileSync(
    workerPath,
    `import { createRequire } from "node:module";
    import { fileURLToPath } from "node:url";
    import { parentPort } from "node:worker_threads";
    const { marker } = createRequire(import.meta.url)(fileURLToPath(new URL("./bridge.js", import.meta.url)));
    parentPort.on("message", () => parentPort.postMessage({ status: "ok", value: marker }));`,
  );
  const pool = new WorkerTaskPool<Record<string, never>, number>({
    workerUrl: pathToFileURL(workerPath),
    maxWorkers: 1,
  });
  try {
    expect(await pool.run({}, { timeoutMs: 10_000 })).toBe(37);
  } finally {
    await pool.close();
  }
});

it("keeps SQLite worker diagnostics off the parent JSON stdout", async () => {
  const home = directories.make("worker-json-logging-");
  const configPath = path.join(home, "openclaw.json");
  fs.writeFileSync(
    configPath,
    JSON.stringify({ logging: { file: path.join(home, "worker.log") } }),
  );
  const { stdout, stderr } = await exec(
    process.execPath,
    resolveRuntimeWorkerArgv(resolveRuntimeWorkerUrl(workerTaskPoolEntrypoints.logging)),
    {
      timeout: 15_000,
      env: {
        PATH: process.env.PATH,
        HOME: home,
        USERPROFILE: home,
        TMPDIR: home,
        OPENCLAW_STATE_DIR: home,
        OPENCLAW_CONFIG_PATH: configPath,
        OPENCLAW_LOG_LEVEL: "debug",
        TSX_DISABLE_CACHE: "1",
        NO_COLOR: "1",
      },
    },
  );
  expect(JSON.parse(stdout)).toEqual({ value: "ready" });
  expect(stderr).toContain("[state/sqlite] SQLite read-only snapshot for synthetic.sqlite:");
});
