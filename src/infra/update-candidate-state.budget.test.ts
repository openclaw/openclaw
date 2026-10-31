import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as realSetTimeout } from "node:timers";
import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { findVitestResourceOwner } from "../../scripts/lib/vitest-resource-ownership.mts";
import { fixtureReceiptClientSource } from "../../test/helpers/fixture-receipts.js";
import { isProcessAlive } from "../../test/helpers/process-wait.js";
import { createDeferred, withinTest } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { hasCommandProcessCleanupError } from "../process/exec-result.js";
import * as commands from "../process/exec.js";
import * as diskSpace from "./disk-space.js";
import { hasErrnoCode } from "./errno.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import { runtimeProcessEntrypoints } from "./runtime-process-entrypoints.js";
import { createSqliteLifecycleAggregateError } from "./sqlite-lifecycle-errors.js";
import { removeTempDirectory } from "./sqlite-readonly-location-cleanup.js";
import { isSqliteSnapshotStagingName } from "./sqlite-snapshot-retirement.js";
import { SQLITE_STAGING_TOKEN_FILES } from "./sqlite-staging-token.js";
import { sqliteWorkerPreloadEnv } from "./sqlite-worker-preload.test-support.js";
import { measureUpdateStateFiles } from "./update-candidate-io.js";
import {
  useStateReceipts,
  stateClock,
  snapshotFixture,
  captureStateOperation,
} from "./update-candidate-state-fixtures.test-support.js";
import {
  parseUpdateStateInspectionWorker,
  runUpdateStateInspectionWorker,
} from "./update-candidate-state.inspection.js";
import {
  readUpdateStateSchemaVersions,
  UpdateStateSchemaInspectionPlanSchema,
} from "./update-candidate-state.js";
import { readUpdateStateDatabaseSizes } from "./update-candidate-state.sizes.js";
import { materializeUpdateCandidateStateWorker } from "./update-candidate-state.test-support.js";
import { UpdateDatabaseBackupSchema } from "./update-database-backup.js";
import { createUpdateErrorFact } from "./update-failure-facts.js";
import { prepareUpdateFailureReport } from "./update-failure-report-prepare.js";
import { UPDATE_STATE_INSPECTION_PROGRESS_PREFIX } from "./update-state-inspection-protocol.js";

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
const receipts = useStateReceipts();

async function writeWorker(root: string, source: string) {
  const worker = path.join(
    root,
    "dist",
    runtimeProcessEntrypoints.updateCandidateState.distWorkerPath,
  );
  await fs.mkdir(path.dirname(worker), { recursive: true });
  await fs.writeFile(path.join(root, "package.json"), '{"type":"module"}');
  await fs.writeFile(worker, source);
}

async function rehearsalScratch(root: string) {
  return (await fs.readdir(root)).filter((name) => name.startsWith("openclaw-update-canary-"));
}

function registerCleanup(
  action: () => Promise<void>,
  onFinished: (fn: () => Promise<void>) => void,
) {
  let pending: Promise<void> | undefined;
  const cleanup = () => (pending ??= action());
  cleanupFixture = cleanup;
  onFinished(cleanup);
  return cleanup;
}

function workerOptions(root: string, signal: AbortSignal) {
  return { nodeRunner: process.execPath, sourceEnv: {}, stagingRoot: root, signal };
}

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

it("keeps one-shot state worker stdout parseable with SQLite debug logging enabled", async ({
  signal,
}) => {
  const root = await fs.realpath(tempDirs.make("state-worker-json-"));
  const stateDir = path.join(root, "source");
  const database = path.join(stateDir, "state", "openclaw.sqlite");
  await fs.mkdir(path.dirname(database), { recursive: true });
  {
    using db = openNodeSqliteDatabase(database);
    db.exec(
      "CREATE TABLE payload(value TEXT); INSERT INTO payload VALUES('fixture'); PRAGMA user_version=7",
    );
  }
  const worker = {
    ...workerOptions(root, signal),
    sourceEnv: {
      HOME: root,
      USERPROFILE: root,
      OPENCLAW_HOME: root,
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_LOG_LEVEL: "debug",
    },
    databases: [{ path: database, sizeBytes: (await fs.stat(database, { bigint: true })).size }],
  };
  const inspectionPlan = parseUpdateStateInspectionWorker(
    await runUpdateStateInspectionWorker({
      ...worker,
      input: { mode: "discover", stateDir, config: {}, stagingRoot: root },
    }),
    UpdateStateSchemaInspectionPlanSchema,
  );
  const backupRoot = path.join(root, "backup");
  await fs.mkdir(`${backupRoot}.databases`);
  const result = await runUpdateStateInspectionWorker({
    ...worker,
    input: {
      mode: "database-backup",
      stateDir,
      config: {},
      stagingRoot: root,
      backupRoot,
      inspectionPlan,
      // Manual original capture still needs the engine snapshot; automatic capture
      // reuses its generation image and need not emit this worker diagnostic.
      originalCaptureSourcePaths: [database],
    },
  });

  expect(parseUpdateStateInspectionWorker(result, UpdateDatabaseBackupSchema)).toMatchObject({
    databases: [expect.objectContaining({ path: database, userVersion: 7 })],
    warnings: [],
  });
  expect(result.stderr).toMatch(
    /\[state\/sqlite\] SQLite read-only snapshot for .*budget \d+ seconds/,
  );
});

it.skipIf(process.platform === "win32").for(["complete", "cancel"] as const)(
  "settles automatic backup with two retained images after %s",
  { timeout: 30_000 },
  async (outcome, { signal, onTestFinished }) => {
    // Retention must survive the enclosing Vitest process owner's namespace cleanup.
    const releaseFixture = findVitestResourceOwner()?.claim();
    // openclaw-temp-dir: allow native cleanup uncertainty must retain worker inputs.
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "backup-retained-")));
    const controller = new AbortController();
    const stateDir = path.join(root, "source");
    const shared = path.join(stateDir, "state", "openclaw.sqlite");
    const second = path.join(root, "second.sqlite");
    const sources = [shared, second];
    const stagingRoot = path.join(root, "staging");
    const workerCacheRoot = path.join(root, "worker-cache");
    const backupRoot = path.join(root, "backup");
    const directory = backupRoot + ".databases";
    const marker = path.join(root, "held.json");
    const release = path.join(root, "release");
    const sentinel = path.join(directory, "operator.txt");
    let pid: number | undefined;
    let operation:
      | Promise<
          { value: Awaited<ReturnType<typeof runUpdateStateInspectionWorker>> } | { error: unknown }
        >
      | undefined;
    let retirementFailure: Error | undefined;
    const unexpectedEntry = (scope: string, entry: Dirent) =>
      new Error(
        `Unexpected ${scope} entry ${JSON.stringify({
          name: entry.name.slice(0, 128),
          type: entry.isDirectory()
            ? "directory"
            : entry.isFile()
              ? "file"
              : entry.isSymbolicLink()
                ? "symlink"
                : "other",
        })}; fixture retained`,
      );
    const assertWorkerCacheEmpty = async () => {
      const cacheStat = await fs.lstat(workerCacheRoot).catch((error: unknown) => {
        if (hasErrnoCode(error, "ENOENT")) {
          return undefined;
        }
        throw error;
      });
      if (!cacheStat) {
        return;
      }
      if (!cacheStat.isDirectory()) {
        throw new Error("Worker cache root is not a real directory; fixture retained");
      }
      for (const entry of await fs.readdir(workerCacheRoot, { withFileTypes: true })) {
        if (entry.name !== "openclaw" || !entry.isDirectory()) {
          throw unexpectedEntry("worker cache", entry);
        }
        // The canonical cache root may remain, but no snapshot work may survive the joined worker.
        const remaining = await fs.readdir(path.join(workerCacheRoot, entry.name), {
          withFileTypes: true,
        });
        if (remaining.length) {
          throw unexpectedEntry("SQLite cache", remaining[0]!);
        }
      }
    };
    const retireSnapshot = (location: string) => {
      try {
        let cause: unknown;
        if (
          !removeTempDirectory(location, (error) => {
            cause = error;
          })
        ) {
          throw new Error("Snapshot retirement refused", { cause });
        }
      } catch (error) {
        // Native refusal keeps its recovery inputs; later test cleanup must not retry or unlink them.
        retirementFailure = new Error("Snapshot retirement unverified; fixture retained", {
          cause: error,
        });
        throw retirementFailure;
      }
    };
    const cleanup = registerCleanup(async () => {
      controller.abort();
      const settled = await operation;
      if (
        (settled && "error" in settled && hasCommandProcessCleanupError(settled.error)) ||
        (pid !== undefined && isProcessAlive(pid))
      ) {
        throw new Error("Backup worker cleanup unverified; fixture retained", {
          cause: settled && "error" in settled ? settled.error : undefined,
        });
      }
      if (retirementFailure) {
        throw retirementFailure;
      }
      const remaining = await fs
        .readdir(stagingRoot, { withFileTypes: true })
        .catch((error: unknown) => {
          if (hasErrnoCode(error, "ENOENT")) {
            return [];
          }
          throw error;
        });
      for (const entry of remaining) {
        if (!entry.isDirectory() || !isSqliteSnapshotStagingName(entry.name)) {
          throw unexpectedEntry("staging", entry);
        }
        retireSnapshot(path.join(stagingRoot, entry.name));
      }
      await assertWorkerCacheEmpty();
      await fs.rm(root, { recursive: true });
      releaseFixture?.();
    }, onTestFinished);
    let bodyFailure: { error: unknown } | undefined;
    try {
      for (const location of [path.dirname(shared), stagingRoot, workerCacheRoot, directory]) {
        await fs.mkdir(location, { recursive: true });
      }
      expect((await fs.stat(stagingRoot)).dev).toBe((await fs.stat(directory)).dev);
      expect((await fs.stat(workerCacheRoot)).dev).toBe((await fs.stat(directory)).dev);
      await fs.writeFile(sentinel, "preserved");
      for (const [index, file] of sources.entries()) {
        using db = openNodeSqliteDatabase(file);
        db.exec("PRAGMA user_version=7; CREATE TABLE payload(witness TEXT, bytes BLOB);");
        db.prepare("INSERT INTO payload VALUES (?, randomblob(?))").run(
          String(index),
          (index + 1) * 2 * 1024 * 1024,
        );
      }
      const original = await Promise.all(sources.map((file) => fs.readFile(file)));
      const sizes = await Promise.all(sources.map(async (file) => (await fs.stat(file)).size));
      const sourceEnv = {
        HOME: root,
        OPENCLAW_HOME: root,
        OPENCLAW_STATE_DIR: stateDir,
        // Match the held-worker preload policy so Bun's compiler cache is not SQLite scratch.
        BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
      };
      const worker = {
        nodeRunner: process.execPath,
        sourceEnv,
        // Worker cache ownership is separate from the explicit retained-image input below.
        stagingRoot: workerCacheRoot,
        signal: AbortSignal.any([signal, controller.signal]),
        databases: await Promise.all(
          sources.map(async (file) => ({
            path: file,
            sizeBytes: (await fs.stat(file, { bigint: true })).size,
          })),
        ),
      };
      // Maintenance preserves source artifacts; a stopped service does not select stopped capture.
      const input = {
        stateDir,
        config: {},
        stagingRoot,
        backupRoot,
        additionalPaths: [second],
        preserveSourceArtifacts: true,
      };
      operation = captureStateOperation(
        runUpdateStateInspectionWorker({
          ...worker,
          input: { ...input, mode: "discover" },
        }),
      );
      const discovered = await withinTest(operation, signal);
      if ("error" in discovered) {
        throw discovered.error;
      }
      const inspectionPlan = parseUpdateStateInspectionWorker(
        discovered.value,
        UpdateStateSchemaInspectionPlanSchema,
      );
      const preload = path.join(root, "hold.cjs");
      await fs.writeFile(
        preload,
        `
const fs = require("node:fs");
const originalWrite = fs.writeSync;
let entered = false;
fs.writeSync = function(...args) {
  if (!entered && args[0] === 2 && typeof args[1] === "string" &&
      args[1].startsWith(${JSON.stringify(UPDATE_STATE_INSPECTION_PROGRESS_PREFIX)})) {
    const progress = JSON.parse(args[1].slice(${UPDATE_STATE_INSPECTION_PROGRESS_PREFIX.length}));
    if (progress.phase === "pre-migration database backup") {
      entered = true;
      fs.writeFileSync(${JSON.stringify(marker + ".tmp")}, JSON.stringify({ pid: process.pid }));
      fs.renameSync(${JSON.stringify(marker + ".tmp")}, ${JSON.stringify(marker)});
      const result = Reflect.apply(originalWrite, this, args);
      // The test signal and registered cleanup own the held worker's lifetime.
      const wait = new Int32Array(new SharedArrayBuffer(4));
      while (!fs.existsSync(${JSON.stringify(release)})) {
        Atomics.wait(wait, 0, 0, 10);
      }
      return result;
    }
  }
  return Reflect.apply(originalWrite, this, args);
};
require("node:module").syncBuiltinESMExports();
`,
      );
      const entered = createDeferred();
      let progressObserved = false;
      operation = captureStateOperation(
        runUpdateStateInspectionWorker({
          ...worker,
          sourceEnv: { ...sourceEnv, ...sqliteWorkerPreloadEnv(preload) },
          input: { ...input, mode: "database-backup", inspectionPlan },
          onProgress: (progress) => {
            if (progress.phase === "pre-migration database backup") {
              progressObserved = true;
              entered.resolve();
            }
          },
        }),
      );
      await withinTest(fixtureEventBeforeSettlement(marker, entered.promise, operation), signal);
      expect(progressObserved).toBe(true);
      const receipt = JSON.parse(await fs.readFile(marker, "utf8")) as { pid: number };
      expect(Number.isSafeInteger(receipt.pid)).toBe(true);
      pid = receipt.pid;
      expect(isProcessAlive(pid)).toBe(true);
      expect(await fs.readdir(directory)).toEqual(["operator.txt"]);

      const retained = (await fs.readdir(stagingRoot, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory() && isSqliteSnapshotStagingName(entry.name))
        .map((entry) => path.join(stagingRoot, entry.name));
      expect(retained).toHaveLength(2);
      const identities = new Set<string>();
      let payloadBytes = 0;
      let allocatedBlockBytes = 0;
      let controlBytes = 0;
      const payloads: Buffer[] = [];
      const payloadPaths: string[] = [];
      for (const location of retained) {
        const files = await fs.readdir(location, { withFileTypes: true });
        expect(files.some((file) => file.name === "owner.sqlite")).toBe(true);
        let payloadCount = 0;
        for (const file of files) {
          expect(file.isFile()).toBe(true);
          const filename = path.join(location, file.name);
          const stat = await fs.lstat(filename);
          const identity = stat.dev + ":" + stat.ino;
          expect(identities.has(identity)).toBe(false);
          identities.add(identity);
          allocatedBlockBytes += stat.blocks * 512;
          if (SQLITE_STAGING_TOKEN_FILES.some((name) => name === file.name)) {
            controlBytes += stat.size;
          } else {
            payloadCount++;
            payloadBytes += stat.size;
            payloads.push(await fs.readFile(filename));
            payloadPaths.push(filename);
          }
        }
        expect(payloadCount).toBe(1);
        expect(removeTempDirectory(location, () => {})).toBe(false);
      }
      for (const [index, file] of payloadPaths.entries()) {
        expect((await fs.readFile(file)).equals(payloads[index]!)).toBe(true);
      }
      const hashes = (values: Buffer[]) =>
        values.map((bytes) => createHash("sha256").update(bytes).digest("hex")).toSorted();
      expect(hashes(payloads)).toEqual(hashes(original));
      expect(payloadBytes).toBe(sizes.reduce((sum, size) => sum + size, 0));
      expect(controlBytes).toBeLessThanOrEqual(2 * 64 * 1024);
      const admittedBytes = 2 * payloadBytes + 3 * Math.max(...sizes) + 64 * 1024 * 1024;
      expect(payloadBytes + controlBytes).toBeLessThanOrEqual(admittedBytes);
      expect(allocatedBlockBytes).toBeGreaterThan(0);
      expect(allocatedBlockBytes).toBeLessThanOrEqual(admittedBytes);
      console.log(
        JSON.stringify({
          event: "retained-inventory-checkpoint",
          outcome,
          families: retained.length,
          payloadBytes,
          controlBytes,
          allocatedBlockBytes,
          accounting: "inode-deduplicated blocks; not exclusive CoW bytes or capture peak",
          admittedBytes,
        }),
      );

      if (outcome === "cancel") {
        const cancellation = new Error("cancel automatic backup with retained inventory");
        expect(isProcessAlive(pid)).toBe(true);
        controller.abort(cancellation);
        expect(await operation).toEqual({ error: cancellation });
        expect(isProcessAlive(pid)).toBe(false);
        // Forced termination can retain scratch; only the existing token owner may retire it.
        for (const location of retained) {
          retireSnapshot(location);
        }
        expect(await fs.readdir(directory)).toEqual(["operator.txt"]);
      } else {
        await fs.writeFile(release, "continue");
        const result = await operation;
        if ("error" in result) {
          throw result.error;
        }
        const backup = parseUpdateStateInspectionWorker(result.value, UpdateDatabaseBackupSchema);
        expect(backup.warnings).toEqual([]);
        expect(backup.databases).toHaveLength(2);
        for (const [index, file] of sources.entries()) {
          const entry = backup.databases.find((value) => value.path === file);
          expect(entry).toBeDefined();
          expect((await fs.readFile(entry!.snapshotPath)).equals(original[index]!)).toBe(true);
          expect(backup.sourceGenerations[file]).toEqual(expect.any(String));
        }
      }
      expect(await fs.readdir(stagingRoot)).toEqual([]);
      await assertWorkerCacheEmpty();
      expect(await fs.readFile(sentinel, "utf8")).toBe("preserved");
      for (const [index, file] of sources.entries()) {
        expect((await fs.readFile(file)).equals(original[index]!)).toBe(true);
        for (const suffix of ["-wal", "-shm", "-journal"]) {
          await expect(fs.stat(file + suffix)).rejects.toMatchObject({ code: "ENOENT" });
        }
      }
    } catch (error) {
      bodyFailure = { error };
    }
    try {
      await cleanup();
    } catch (cleanupError) {
      if (bodyFailure) {
        throw createSqliteLifecycleAggregateError(
          [bodyFailure.error, cleanupError],
          "Retained backup fixture failed and cleanup was not verified",
          bodyFailure.error,
        );
      }
      throw cleanupError;
    }
    if (bodyFailure) {
      throw bodyFailure.error;
    }
  },
);

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
      ...workerOptions(root, controller.signal),
      sourceEnv: { ...process.env, ...sqliteWorkerPreloadEnv(preload) },
      timeoutMs,
    }).then(
      (sizes) => ({ sizes }),
      (error: unknown) => ({ error }),
    );
    const cleanup = registerCleanup(async () => {
      try {
        await fs.writeFile(release, "continue");
      } finally {
        // A failed release must still cancel and join the blocked stat worker.
        controller.abort();
        await operation;
      }
    }, onTestFinished);
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
      // Keep the default worker blocked until the deferred timeout decision settles.
      if (timeoutMs === undefined) {
        const outcome = await operation;
        expect(outcome).toHaveProperty(
          "error.message",
          expect.stringContaining("inventory failed (timeout"),
        );
        expect(outcome).toHaveProperty("error.message", expect.stringContaining(file));
      } else {
        expect(() => process.kill(pid, 0)).not.toThrow();
        await fs.writeFile(release, "continue");
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
  { name: "large database", bytes: 2 * 1024 ** 3, elapsedMs: 800_000 },
  { name: "growing scratch", discoveredBytes: 2 * 1024 ** 3, elapsedMs: 800_000, completes: false },
  { name: "stalled worker", elapsedMs: 400_000, completes: false },
  { name: "caller allowance", elapsedMs: 400_000, timeoutMs: 600_000 },
  { name: "configured cache", configuredCache: true },
  { name: "large diagnostic output", diagnosticBytes: 40_000 },
])(
  "budgets schema inspection for $name",
  async (
    {
      bytes = 4096,
      discoveredBytes,
      elapsedMs = 0,
      completes = true,
      configuredCache,
      timeoutMs,
      diagnosticBytes,
    },
    { signal, onTestFinished },
  ) => {
    const root = tempDirs.make("openclaw-state-budget-");
    const stateDir = path.join(root, "source");
    const database = path.join(stateDir, "agents", "main", "agent", "openclaw-agent.sqlite");
    await fs.mkdir(path.dirname(database), { recursive: true });
    const file = await fs.open(database, "w");
    await file.truncate(bytes);
    await file.close();
    const ready = path.join(root, "ready");
    const release = path.join(root, "release");
    const cache = path.join(root, "configured-cache");
    await fs.mkdir(cache);
    await writeWorker(
      root,
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
      while (${elapsedMs > 0} && !(await fs.stat(${JSON.stringify(release)}).catch(() => undefined))) {
        await sleep(10);
      }
      process.stdout.write(JSON.stringify([{ path: ${JSON.stringify(database)}, userVersion: 3 }]));
      }
    `,
    );

    const advanceClock = stateClock();
    const controller = new AbortController();
    const result = readUpdateStateSchemaVersions({
      root,
      stateDir,
      config: {},
      timeoutMs,
      env: configuredCache ? { XDG_CACHE_HOME: cache } : {},
      signal: controller.signal,
    }).then(
      (versions) => ({ versions }),
      (error: unknown) => ({ error }),
    );
    const cleanup = registerCleanup(async () => {
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
    }, onTestFinished);
    try {
      if (elapsedMs > 0) {
        await withinTest(
          fixtureEventBeforeSettlement(ready, receipts.waitFor(ready, "ready"), result),
          signal,
        );
        advanceClock(elapsedMs);
        if (!completes) {
          advanceClock(elapsedMs, true);
          await result;
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

it.each([false, true])(
  "retains rehearsal scratch when worker settlement is uncertain (cancelled=%s)",
  async (cancelled) => {
    const root = await fs.realpath(tempDirs.make("rehearsal-unsettled-"));
    const stateDir = path.join(root, "source");
    const controller = new AbortController();
    vi.spyOn(commands, "runUtf8CommandWithTimeout").mockImplementation(async () => {
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
    const operation = snapshotFixture(root, stateDir, controller.signal);
    try {
      await expect(operation).rejects.toThrow(/cleanup.*confirmed|settlement.*uncertain/);
      const retained = await rehearsalScratch(root);
      expect(retained).toHaveLength(1);
      expect((await fs.stat(path.join(root, retained[0]!))).isDirectory()).toBe(true);
    } finally {
      controller.abort();
      await operation.catch(() => {});
    }
  },
);

// Insert fixture code behind the real executable, preserving argv-based Windows
// launch and the actual process/output/cleanup owners.
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
      const failure = await snapshotFixture(
        root,
        path.join(root, "source"),
        controller.signal,
        () => ({ ...process.env }),
      ).catch((error: unknown) => error);
      expect(failure).toMatchObject({
        code: "output-limit",
        message: expect.stringMatching(/^Update state snapshot failed \(output-limit\):/),
      });
      expect(createUpdateErrorFact("candidate-state-snapshot", failure).code).toBe("output-limit");
      expect(deadlineReached).toBe(false);
      // Snapshot rejection follows the command owner's process-tree settlement.
      const pid = Number(await fs.readFile(pidPath, "utf8"));
      expect(isProcessAlive(pid)).toBe(false);
      expect(await rehearsalScratch(root)).toEqual([]);
    } finally {
      clearTimeout(deadline);
      controller.abort();
    }
  },
);

it.for([false, true])(
  "reports a real inspection output limit through the public report (warnings=%s)",
  async (warnings, { signal }) => {
    const root = await fs.realpath(tempDirs.make("inspection-output-limit-"));
    await writeWorker(
      root,
      `
    for await (const chunk of process.stdin) {}
    setInterval(() => {}, 1000);
    process.stdout.write("private-machine-payload".repeat(4));
  `,
    );
    const result = await runUpdateStateInspectionWorker({
      ...workerOptions(root, signal),
      input: { mode: "runtime-retention", stateDir: root, config: {} },
      root,
      databases: [],
      sources: [root],
      maxOutputBytes: 64,
      ioBudget: "deadline",
    });
    expect(result).toMatchObject({ termination: "signal", outputLimitExceeded: true });
    let failure: unknown;
    try {
      // Separate pipes have no observation order. Keep the real process outcome,
      // then supply captured warnings at the parser boundary deterministically.
      parseUpdateStateInspectionWorker(
        {
          ...result,
          stderr: warnings ? "ExperimentalWarning: private-customer warning\nSQLITE_BUSY\n" : "",
        },
        z.unknown(),
      );
    } catch (error) {
      failure = error;
    }
    const report = await prepareUpdateFailureReport(
      {
        attemptId: "inspection-output-limit",
        result: {
          status: "error",
          mode: "git",
          reason: "update-failed",
          durationMs: 1,
          steps: [
            {
              name: "updater-runtime-retention",
              command: "inspection",
              cwd: root,
              durationMs: 1,
              exitCode: 1,
              failureFacts: [
                createUpdateErrorFact("git update", failure, { OPENCLAW_STATE_DIR: root }),
              ],
            },
          ],
        },
      },
      { env: { OPENCLAW_STATE_DIR: root } },
    );
    expect(report.body).toContain("Failing check git update (output-limit)");
    expect(report.body).not.toMatch(/private-customer|ExperimentalWarning|private-machine-payload/);
    expect(report.body).not.toContain(root);
  },
);

it("preserves an inventory worker output limit without blaming the process supervisor", async ({
  signal,
}) => {
  const root = await fs.realpath(tempDirs.make("inventory-output-limit-"));
  const file = path.join(root, "source.sqlite");
  await fs.writeFile(file, "source");
  const run = commands.runUtf8CommandWithTimeout;
  vi.spyOn(commands, "runUtf8CommandWithTimeout").mockImplementation((argv, options) => {
    if (typeof options === "number") {
      throw new Error("Expected inventory capture options");
    }
    // Exercise the real inventory child and runner without a megabyte of paths.
    return run(argv, { ...options, maxOutputBytes: { stdout: 1, stderr: 20_000 } });
  });
  const failure = await readUpdateStateDatabaseSizes([file], workerOptions(root, signal)).catch(
    (error: unknown) => error,
  );
  expect(failure).toHaveProperty("code", "output-limit");
  expect(await fs.readFile(file, "utf8")).toBe("source");
});

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
    const outcome = captureStateOperation(snapshotFixture(root, stateDir, controller.signal));
    try {
      expect(await outcome).toMatchObject({
        error: {
          capacity: expect.objectContaining({ reason: "snapshot-capacity-insufficient" }),
        },
      });
      expect(db.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
      expect(db.prepare("SELECT length(bytes) AS n FROM payload").get()).toEqual({ n: 2097152 });
      expect(await rehearsalScratch(root)).toEqual([]);
    } finally {
      controller.abort();
      await outcome;
    }
  } finally {
    db.close();
  }
});
