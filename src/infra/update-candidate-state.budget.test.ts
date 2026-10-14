import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as realSetTimeout } from "node:timers";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import {
  fixtureReceiptClientSource,
  openFixtureReceiptChannel,
  type FixtureReceiptChannel,
} from "../../test/helpers/fixture-receipts.js";
import { isProcessAlive } from "../../test/helpers/process-wait.js";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as commands from "../process/exec.js";
import * as diskSpace from "./disk-space.js";
import { hasErrnoCode } from "./errno.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import { runtimeProcessEntrypoints } from "./runtime-process-entrypoints.js";
import { sqliteWorkerPreloadEnv } from "./sqlite-worker-preload.test-support.js";
import { measureUpdateStateFiles } from "./update-candidate-io.js";
import { observeUpdateCandidateIoProgress } from "./update-candidate-io.test-support.js";
import { prepareUpdateCandidateStateSnapshot } from "./update-candidate-snapshot.js";
import { readUpdateStateSchemaVersions } from "./update-candidate-state.js";
import { readUpdateStateDatabaseSizes } from "./update-candidate-state.sizes.js";
import { materializeUpdateCandidateStateWorker } from "./update-candidate-state.test-support.js";

let cleanupFixture: (() => Promise<void>) | undefined;
const tempDirs = useAutoCleanupTempDirTracker((cleanupDirs) =>
  afterEach(async () => {
    try {
      // afterEach precedes onTestFinished, including while a timed-out body unwinds.
      await cleanupFixture?.();
    } finally {
      cleanupFixture = undefined;
      vi.useRealTimers();
      vi.restoreAllMocks();
      cleanupDirs();
    }
  }),
);
let receipts: FixtureReceiptChannel;
beforeAll(async () => {
  receipts = await openFixtureReceiptChannel();
});
afterAll(async () => {
  await receipts.close();
});

// Receipts and command settlement travel independently. The fixture publishes the
// complete marker before it can reply, so that record decides a settlement race.
async function fixtureEventBeforeSettlement(
  file: string,
  receipt: Promise<void>,
  operation: PromiseLike<unknown>,
): Promise<void> {
  const settled = Promise.resolve(operation).then(async () => {
    await fs.access(file).catch((error: unknown) => {
      if (hasErrnoCode(error, "ENOENT")) {
        throw new Error(`Worker did not reach ${path.basename(file)}`);
      }
      throw error;
    });
  });
  await Promise.race([receipt, settled]);
}

it.for([undefined, 600_000])(
  "honors the %s ms allowance during metadata inventory",
  async (timeoutMs, { signal, onTestFinished }) => {
    const root = tempDirs.make("openclaw-metadata-budget-");
    const file = path.join(root, "database.sqlite");
    const ready = path.join(root, "ready");
    const release = path.join(root, "release");
    const preload = path.join(root, "metadata-wait.cjs");
    await fs.writeFile(file, "database");
    await fs.writeFile(
      preload,
      `
    const fs = require("node:fs");
    const stat = fs.statSync;
    fs.statSync = function(file, ...args) {
      if (file === ${JSON.stringify(file)}) {
        fs.writeFileSync(${JSON.stringify(`${ready}.tmp`)}, JSON.stringify({ pid: process.pid }));
        fs.renameSync(${JSON.stringify(`${ready}.tmp`)}, ${JSON.stringify(ready)});
        fs.writeSync(2, "metadata fixture ready\\n");
        while (!fs.existsSync(${JSON.stringify(release)})) {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
        }
      }
      return stat.call(this, file, ...args);
    };
  `,
    );
    // The stat hook blocks its event loop; synchronous stderr still reaches the
    // command's existing output observer without waiting for a socket connection.
    const readyReceipt = createDeferred();
    const run = commands.runUtf8CommandWithTimeout;
    vi.spyOn(commands, "runUtf8CommandWithTimeout").mockImplementation((argv, options) => {
      if (typeof options === "number") {
        return run(argv, options);
      }
      let stderr = "";
      return run(argv, {
        ...options,
        onOutputChunk(chunk, stream) {
          const result = options.onOutputChunk?.(chunk, stream);
          if (stream === "stderr") {
            stderr += chunk.toString();
            if (stderr.includes("metadata fixture ready\n")) {
              readyReceipt.resolve();
            }
          }
          return result;
        },
      });
    });
    const timers = vi.spyOn(globalThis, "setTimeout");
    const controller = new AbortController();
    const operation = readUpdateStateDatabaseSizes([file], {
      nodeRunner: process.execPath,
      sourceEnv: { ...process.env, ...sqliteWorkerPreloadEnv(preload) },
      stagingRoot: root,
      timeoutMs,
      signal: controller.signal,
    }).then(
      (sizes) => ({ sizes }),
      (error: unknown) => ({ error }),
    );
    let cleanupPromise: Promise<void> | undefined;
    const cleanup = () =>
      (cleanupPromise ??= (async () => {
        try {
          await fs.writeFile(release, "continue");
        } finally {
          // A failed release must still cancel and join the blocked stat worker.
          controller.abort();
          await operation;
        }
      })());
    cleanupFixture = cleanup;
    onTestFinished(cleanup);
    try {
      await withinTest(
        fixtureEventBeforeSettlement(ready, readyReceipt.promise, operation),
        signal,
      );
      const { pid } = JSON.parse(await fs.readFile(ready, "utf8")) as { pid: number };
      const deadlines = timers.mock.calls.flatMap(([callback, delay, ...args], index) =>
        delay !== undefined && delay >= 30_000 ? [{ callback, delay, args, index }] : [],
      );
      expect(deadlines).toHaveLength(1);
      // Advance only the inspection allowance. Native signal delivery and
      // process-group cleanup must retain their real clock and grace periods.
      for (const deadline of deadlines) {
        if (deadline.delay > 400_000) {
          continue;
        }
        const timer = timers.mock.results[deadline.index];
        if (timer?.type !== "return") {
          throw new Error("Inspection deadline was not scheduled");
        }
        clearTimeout(timer.value);
        deadline.callback(...deadline.args);
      }
      if (timeoutMs !== undefined) {
        expect(() => process.kill(pid, 0)).not.toThrow();
      }
      await fs.writeFile(release, "continue");
      if (timeoutMs === undefined) {
        expect(await operation).toMatchObject({
          error: expect.objectContaining({
            message: expect.stringContaining("inventory failed (timeout"),
          }),
        });
        expect.soft(await operation).toMatchObject({
          error: {
            message: expect.stringContaining(file),
          },
        });
        expect.soft(await operation).toMatchObject({
          error: {
            message: expect.stringMatching(/after \d+(?:\.\d+)? seconds during metadata inventory/),
          },
        });
        expect.soft(await operation).toMatchObject({
          error: {
            message: expect.stringContaining("then retry the update"),
          },
        });
      } else {
        expect(await operation).toEqual({ sizes: [{ path: file, sizeBytes: 8n }] });
      }
      expect(() => process.kill(pid, 0)).toThrow();
      expect(await fs.readFile(file, "utf8")).toBe("database");
    } finally {
      await cleanup();
    }
  },
);

it.for([
  { name: "large database", bytes: 2 * 1024 ** 3, waits: [800_000], completes: true },
  {
    name: "late-discovered database",
    bytes: 4096,
    discoveredBytes: 2 * 1024 ** 3,
    waits: [800_000],
    completes: true,
  },
  {
    name: "continuing copy progress",
    bytes: 4096,
    waits: [200_000, 200_000, 200_000],
    completes: true,
  },
  { name: "stalled worker", bytes: 4096, waits: [400_000], completes: false },
  { name: "caller allowance", bytes: 4096, waits: [400_000], completes: true, timeoutMs: 600_000 },
  { name: "configured cache", bytes: 4096, waits: [0], completes: true, configuredCache: true },
  {
    name: "large diagnostic output",
    bytes: 4096,
    waits: [0],
    completes: true,
    diagnosticBytes: 40_000,
  },
])(
  "budgets schema inspection for $name",
  async (
    { bytes, discoveredBytes, waits, completes, configuredCache, timeoutMs, diagnosticBytes },
    { signal, onTestFinished },
  ) => {
    const root = tempDirs.make("openclaw-state-budget-");
    const stateDir = path.join(root, "source");
    const database = path.join(stateDir, "agents", "main", "agent", "openclaw-agent.sqlite");
    await fs.mkdir(path.dirname(database), { recursive: true });
    const file = await fs.open(database, "w");
    await file.truncate(bytes);
    await file.close();
    const worker = path.join(
      root,
      "dist",
      runtimeProcessEntrypoints.updateCandidateState.distWorkerPath,
    );
    const ready = path.join(root, "ready");
    const release = path.join(root, "release");
    const progress = path.join(root, "progress");
    const cache = path.join(root, "configured-cache");
    await fs.mkdir(cache);
    await fs.mkdir(path.dirname(worker), { recursive: true });
    await fs.writeFile(path.join(root, "package.json"), '{"type":"module"}');
    await fs.writeFile(
      worker,
      `
      import fs from "node:fs/promises";
      import path from "node:path";
      import { setTimeout as sleep } from "node:timers/promises";
      ${fixtureReceiptClientSource(receipts.endpoint)}
      let input = "";
      for await (const chunk of process.stdin) input += chunk;
      const request = JSON.parse(input);
      if (request.mode === "discover") {
        process.stdout.write(JSON.stringify({
          files: [[${JSON.stringify(database)}, { spellings: [${JSON.stringify(database)}] }]],
          sharedVersion: { path: path.join(request.stateDir, "state", "openclaw.sqlite"), userVersion: null },
        }));
      } else {
      if (request.mode !== "versions") throw new Error("Unexpected worker operation");
      process.stderr.write("x".repeat(${diagnosticBytes ?? 0}));
      const scratch = process.env.XDG_CACHE_HOME || ${JSON.stringify(path.join(root, "scratch"))};
      await fs.mkdir(scratch, { recursive: true });
      const copy = path.join(scratch, "database.sqlite");
      await fs.writeFile(copy, "copy");
      if (${discoveredBytes ?? 0}) await fs.truncate(copy, ${discoveredBytes ?? 0});
      // Existence signals readiness, so publish the complete scratch path together.
      await fs.writeFile(${JSON.stringify(`${ready}.tmp`)}, await fs.realpath(scratch));
      await fs.rename(${JSON.stringify(`${ready}.tmp`)}, ${JSON.stringify(ready)});
      sendReceipt(${JSON.stringify(ready)}, "ready");
      let last = "";
      while (${waits.some((milliseconds) => milliseconds > 0)} && !(await fs.stat(${JSON.stringify(release)}).catch(() => undefined))) {
        const next = await fs.readFile(${JSON.stringify(progress)}, "utf8").catch(() => "");
        if (next && next !== last) {
          await fs.appendFile(copy, next);
          await fs.writeFile(${JSON.stringify(progress)} + "." + next, "written");
          sendReceipt(${JSON.stringify(progress)}, next);
          last = next;
        }
        await sleep(10);
      }
      process.stdout.write(JSON.stringify([{ path: ${JSON.stringify(database)}, userVersion: 3 }]));
      }
    `,
    );

    const now = Date.now.bind(Date);
    let elapsed = 0;
    vi.spyOn(Date, "now").mockImplementation(() => now() + elapsed);
    const waitForObservation = observeUpdateCandidateIoProgress();
    const controller = new AbortController();
    let failed = false;
    const result = readUpdateStateSchemaVersions({
      root,
      stateDir,
      config: {},
      timeoutMs,
      env: configuredCache ? { XDG_CACHE_HOME: cache } : {},
      signal: controller.signal,
    }).then(
      (versions) => ({ versions }),
      (error: unknown) => {
        failed = true;
        return { error };
      },
    );
    let cleanupPromise: Promise<void> | undefined;
    const cleanup = () =>
      (cleanupPromise ??= (async () => {
        try {
          await fs.writeFile(release, "done");
        } catch (error) {
          controller.abort(error);
          throw error;
        } finally {
          if (signal.aborted) {
            controller.abort(signal.reason);
          }
          await result;
        }
      })());
    cleanupFixture = cleanup;
    onTestFinished(cleanup);
    try {
      if (waits.some((milliseconds) => milliseconds > 0)) {
        await withinTest(
          fixtureEventBeforeSettlement(ready, receipts.waitFor(ready, "ready"), result),
          signal,
        );
        await withinTest(waitForObservation(discoveredBytes ?? 4), signal);
        for (const [index, milliseconds] of waits.entries()) {
          elapsed += milliseconds;
          if (failed) {
            break;
          }
          if (index < waits.length - 1) {
            await fs.writeFile(progress, String(index + 1));
            await withinTest(
              fixtureEventBeforeSettlement(
                `${progress}.${index + 1}`,
                receipts.waitFor(progress, String(index + 1)),
                result,
              ),
              signal,
            );
            await withinTest(waitForObservation(4 + index + 1), signal);
          }
        }
      } else {
        await result;
      }
      if (configuredCache) {
        const actual = await fs.readFile(ready, "utf8");
        const relative = path.relative(await fs.realpath(cache), actual);
        expect(path.isAbsolute(relative)).toBe(false);
        expect(relative.split(path.sep)[0]).not.toBe("..");
      }
    } finally {
      await cleanup();
    }
    if (completes) {
      expect(await result).toEqual({ versions: [{ path: database, userVersion: 3 }] });
    } else {
      expect(await result).toMatchObject({ error: expect.any(Error) });
    }
  },
);

it.each(
  (["probe", "worker"] as const).flatMap((source) =>
    [false, true].map((cancelled) => ({ source, cancelled })),
  ),
)(
  "retains rehearsal scratch when $source settlement is uncertain (cancelled=$cancelled)",
  async ({ source, cancelled }) => {
    const root = await fs.realpath(tempDirs.make("rehearsal-unsettled-"));
    const stateDir = path.join(root, "source");
    vi.useFakeTimers();
    const controller = new AbortController();
    const workerEntered = createDeferred();
    const workerExit =
      createDeferred<Awaited<ReturnType<typeof commands.runUtf8CommandWithTimeout>>>();
    const original = commands.runUtf8CommandWithTimeout;
    vi.spyOn(commands, "runUtf8CommandWithTimeout").mockImplementation(async (argv, options) => {
      if ((source === "probe") !== argv.includes("--eval")) {
        if (source === "probe") {
          // Keep admitted work pending through the reported-progress quiet period.
          workerEntered.resolve();
          return workerExit.promise;
        }
        return original(argv, options);
      }
      if (cancelled) {
        controller.abort(new Error("caller cancellation"));
      }
      return {
        stdout: "",
        stderr: "",
        code: null,
        signal: null,
        killed: true,
        termination: "signal",
        cleanup: "uncertain",
      };
    });
    const operation = prepareUpdateCandidateStateSnapshot({
      config: {},
      stateDir,
      candidateRoot: root,
      env: { TMPDIR: root },
      workerEnv: () => ({ ...process.env, OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" }),
      signal: controller.signal,
    });
    const rejected = expect(operation).rejects.toThrow(/cleanup.*confirmed|settlement.*uncertain/);
    const settleWorker = () =>
      workerExit.resolve({
        stdout: "",
        stderr: "",
        code: null,
        signal: null,
        killed: true,
        termination: "signal",
        cleanup: "normal",
      });
    try {
      if (source === "probe") {
        await awaitGateBeforeSettlement(
          workerEntered.promise,
          operation,
          "worker was not admitted",
        );
        await vi.advanceTimersByTimeAsync(1_000);
        settleWorker();
      }
      await rejected;
      const retained = (await fs.readdir(root)).filter((name) =>
        name.startsWith("openclaw-update-canary-"),
      );
      expect(retained).toHaveLength(1);
      expect((await fs.stat(path.join(root, retained[0]!))).isDirectory()).toBe(true);
    } finally {
      controller.abort();
      settleWorker();
      await operation.catch(() => {});
    }
  },
);

// Insert fixture code behind the real executable, preserving argv-based Windows
// launch and the actual process/output/cleanup owners. Progress probes run unchanged.
function useRehearsalWorkerFixture(runner: string): void {
  const run = commands.runUtf8CommandWithTimeout;
  vi.spyOn(commands, "runUtf8CommandWithTimeout").mockImplementation((argv, options) =>
    run(
      argv.some((arg) => /[/\\]update-candidate-state\.worker\.[cm]?[jt]s$/.test(arg))
        ? [process.execPath, runner, ...argv.slice(1)]
        : argv,
      options,
    ),
  );
}

it.each(["stdout", "stderr"] as const)(
  "terminates a rehearsal worker exceeding its %s limit",
  async (stream) => {
    const root = await fs.realpath(tempDirs.make("rehearsal-output-limit-"));
    const pidPath = path.join(root, "worker.pid");
    const runner = path.join(root, "overflow.mjs");
    await fs.writeFile(
      runner,
      `
    import fs from "node:fs";
    for await (const chunk of process.stdin) {}
    process.on("SIGTERM", () => {});
    fs.writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));
    process[${JSON.stringify(stream)}].write("x".repeat(2 * 1024 * 1024));
    setInterval(() => {}, 1000);
  `,
    );
    useRehearsalWorkerFixture(runner);
    const controller = new AbortController();
    let deadlineReached = false;
    const deadline = realSetTimeout(() => {
      deadlineReached = true;
      controller.abort(new Error("test output deadline"));
    }, 10_000);
    try {
      await expect(
        prepareUpdateCandidateStateSnapshot({
          config: {},
          stateDir: path.join(root, "source"),
          candidateRoot: root,
          env: { TMPDIR: root },
          workerEnv: () => ({ ...process.env }),
          signal: controller.signal,
        }),
      ).rejects.toThrow(/^Update state snapshot failed \(output-limit\):/);
      expect(deadlineReached).toBe(false);
      // Snapshot rejection follows the command owner's process-tree settlement.
      const pid = Number(await fs.readFile(pidPath, "utf8"));
      expect(isProcessAlive(pid)).toBe(false);
      expect(
        (await fs.readdir(root)).filter((name) => name.startsWith("openclaw-update-canary-")),
      ).toEqual([]);
    } finally {
      clearTimeout(deadline);
      controller.abort();
    }
  },
);

it("refuses a grown WAL family at the post-inventory capacity gate", async () => {
  const root = await fs.realpath(tempDirs.make("rehearsal-wal-growth-"));
  await materializeUpdateCandidateStateWorker(root);
  const stateDir = path.join(root, "source");
  const database = path.join(stateDir, "state", "openclaw.sqlite");
  await fs.mkdir(path.dirname(database), { recursive: true });
  const db = openNodeSqliteDatabase(database);
  try {
    db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE payload(bytes BLOB);",
    );
    const measured = await measureUpdateStateFiles([database]);
    const free = measured.bytes * 2 + measured.largest * 3 + 64 * 1024 * 1024 + 1024 * 1024;
    vi.spyOn(diskSpace, "tryReadDiskSpace").mockReturnValue({
      targetPath: root,
      checkedPath: root,
      availableBytes: free,
      totalBytes: free,
    });
    const run = commands.runUtf8CommandWithTimeout;
    vi.spyOn(commands, "runUtf8CommandWithTimeout").mockImplementation(async (...args) => {
      const [argv, options] = args;
      if (!argv.some((arg) => /[/\\]update-candidate-state\.worker\.[cm]?[jt]s$/.test(arg))) {
        return run(...args);
      }
      if (typeof options === "number" || typeof options.input !== "string") {
        throw new Error("Expected a serialized inventory request");
      }
      expect(JSON.parse(options.input)).toMatchObject({ mode: "inventory" });
      const result = await run(...args);
      // Grow the real WAL after inventory settles, before the parent remeasures it.
      if (result.code === 0 && result.termination === "exit") {
        db.exec("INSERT INTO payload VALUES (zeroblob(2097152));");
      }
      return result;
    });
    const controller = new AbortController();
    const operation = prepareUpdateCandidateStateSnapshot({
      config: {},
      stateDir,
      candidateRoot: root,
      env: { TMPDIR: root },
      workerEnv: () => ({ ...process.env, OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" }),
      signal: controller.signal,
    });
    const outcome = operation.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    try {
      expect(await outcome).toMatchObject({
        error: {
          capacity: expect.objectContaining({ reason: "snapshot-capacity-insufficient" }),
        },
      });
      expect(db.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
      expect(db.prepare("SELECT length(bytes) AS n FROM payload").get()).toEqual({ n: 2097152 });
      expect(
        (await fs.readdir(root)).filter((name) => name.startsWith("openclaw-update-canary-")),
      ).toEqual([]);
    } finally {
      controller.abort();
      await outcome;
    }
  } finally {
    db.close();
  }
});
