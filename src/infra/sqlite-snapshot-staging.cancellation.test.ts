import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import {
  fixtureReceiptClientSource,
  openFixtureReceiptChannel,
  type FixtureReceiptChannel,
} from "../../test/helpers/fixture-receipts.js";
import { withinTest } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { waitForSignalExitBarriers } from "../cli/signal-exit-barrier.js";
import { createDeferredCore } from "../shared/deferred.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { openNodeSqliteDatabase, requireNodeSqlite } from "./node-sqlite.js";
import { SQLITE_READONLY_CHILD_ARG } from "./runtime-process-entrypoints.js";
import * as workerUrls from "./runtime-worker-url.js";
import { cleanupSnapshotOperations } from "./sqlite-readonly-location-cleanup.js";
import { withSqliteReadOnlyWorkerScope } from "./sqlite-readonly-worker.js";
import { prepareSqliteReadOnlyLocation } from "./sqlite-snapshot-source.js";
import { reclaimAbandonedSqliteSnapshotsAsync } from "./sqlite-snapshot-staging.js";
import { readUpdateStateSchemaVersions } from "./update-candidate-state.js";

const processMocks = vi.hoisted(() => ({
  execFile: vi.fn<typeof import("node:child_process").execFile>(),
}));
vi.mock("node:child_process", async (importOriginal) => {
  const { promisify } = await import("node:util");
  const actual = await importOriginal<typeof import("node:child_process")>();
  processMocks.execFile.mockImplementation(actual.execFile);
  Object.defineProperty(
    processMocks.execFile,
    promisify.custom,
    Object.getOwnPropertyDescriptor(actual.execFile, promisify.custom)!,
  );
  return { ...actual, execFile: processMocks.execFile };
});

let receipts: FixtureReceiptChannel;
beforeAll(async () => {
  receipts = await openFixtureReceiptChannel();
});
afterAll(async () => {
  await receipts?.close();
});

type Worker = { child: ChildProcess; closed: Promise<void>; settled: boolean; stderr: string };
const workers = new Map<string, Worker>();
const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(async () => {
    await Promise.all([...workers.values()].map((worker) => worker.closed));
    closeOpenClawStateDatabaseForTest();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    cleanup();
  });
});
beforeEach(async () => {
  workers.clear();
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  processMocks.execFile.mockReset().mockImplementation((file, args, options, callback) => {
    const child = actual.execFile(file, args, options, callback);
    const marker = args?.indexOf(SQLITE_READONLY_CHILD_ARG) ?? -1;
    const root = args?.[marker + 2];
    if (marker >= 0 && args?.[marker + 1] === "reclaim" && root) {
      const worker: Worker = { child, settled: false, closed: Promise.resolve(), stderr: "" };
      child.stderr?.on("data", (chunk: Buffer | string) => {
        worker.stderr = `${worker.stderr}${String(chunk)}`.slice(-4000);
      });
      worker.closed = new Promise<void>((resolve) => {
        child.once("close", () => {
          worker.settled = true;
          resolve();
        });
      });
      workers.set(path.resolve(root), worker);
    }
    return child;
  });
});

it("skips empty reclamation passes and observes later snapshot allocations", async () => {
  const cache = tempDirs.make("sqlite-reclaim-empty-");
  await reclaimAbandonedSqliteSnapshotsAsync(cache);
  expect(processMocks.execFile).toHaveBeenCalledTimes(0);

  const unrelated = path.join(cache, "operator-data");
  const namedFile = path.join(cache, "openclaw-sqlite-readonly-12345-File00");
  fs.mkdirSync(unrelated);
  fs.writeFileSync(namedFile, "preserved");
  await reclaimAbandonedSqliteSnapshotsAsync(cache);
  expect(processMocks.execFile).toHaveBeenCalledTimes(0);

  const abandoned = path.join(cache, "openclaw-sqlite-readonly-12345-Later0");
  fs.mkdirSync(abandoned);
  const stale = new Date(Date.now() - 25 * 60 * 60 * 1000);
  fs.utimesSync(abandoned, stale, stale);
  await reclaimAbandonedSqliteSnapshotsAsync(cache);
  expect(processMocks.execFile).toHaveBeenCalledTimes(1);
  expect(fs.existsSync(abandoned)).toBe(false);
  expect(fs.readdirSync(cache).toSorted()).toEqual([path.basename(namedFile), "operator-data"]);
  expect(fs.readFileSync(namedFile, "utf8")).toBe("preserved");
});

it("joins a pending reclamation scan and prevents a late launch during shutdown", async () => {
  const cache = tempDirs.make("sqlite-reclaim-scanning-");
  const abandoned = path.join(cache, "openclaw-sqlite-readonly-12345-Later0");
  fs.mkdirSync(abandoned);
  const entered = createDeferredCore();
  const release = createDeferredCore();
  const readdir = fs.promises.readdir;
  vi.spyOn(fs.promises, "readdir").mockImplementation(async (...args) => {
    const entries = await readdir(...args);
    if (args[0] === cache) {
      entered.resolve();
      await release.promise;
    }
    return entries;
  });
  const reclamation = reclaimAbandonedSqliteSnapshotsAsync(cache);
  let shutdown: Promise<void> | undefined;
  let shutdownSettled = false;
  try {
    await Promise.race([
      entered.promise,
      reclamation.then(() => {
        throw new Error("Reclamation settled before its candidate scan");
      }),
    ]);
    shutdown = cleanupSnapshotOperations().then(() => {
      shutdownSettled = true;
    });
    expect((await fs.promises.stat(abandoned)).isDirectory()).toBe(true);
    expect(shutdownSettled).toBe(false);
    expect(processMocks.execFile).toHaveBeenCalledTimes(0);
    release.resolve();
    await shutdown;
    await reclamation;
    expect(processMocks.execFile).toHaveBeenCalledTimes(0);
    expect(fs.existsSync(abandoned)).toBe(true);
  } finally {
    release.resolve();
    await Promise.allSettled([reclamation, shutdown]);
  }
});

function fixture(count = 3, payloadBytes = 4096) {
  const root = tempDirs.make("sqlite-reclaim-cancellation-");
  const cacheHome = path.join(root, "cache");
  const cache = path.join(cacheHome, "openclaw");
  const source = path.join(root, "source.sqlite");
  const gatePath = path.join(root, "gate.sqlite");
  const marker = path.join(root, "entered.json");
  const harness = path.join(root, "worker.mts");
  const sqlite = requireNodeSqlite();
  const database = new sqlite.DatabaseSync(source);
  database.exec(
    "PRAGMA user_version=3; CREATE TABLE probe(value TEXT); INSERT INTO probe VALUES('preserved');",
  );
  database.close();
  const gate = new sqlite.DatabaseSync(gatePath);
  gate.exec("CREATE TABLE gate(value INTEGER); BEGIN IMMEDIATE;");
  fs.mkdirSync(cache, { recursive: true });
  const payload = Buffer.alloc(payloadBytes);
  const stale = new Date(Date.now() - 25 * 60 * 60 * 1000);
  const roots = Array.from({ length: count }, (_, index) => {
    const parent = path.join(
      cache,
      `openclaw-sqlite-readonly-12345-${String(index).padStart(6, "0")}`,
    );
    const container = path.join(parent, "openclaw");
    const inner = path.join(container, "openclaw-sqlite-readonly-12345-Worker");
    fs.mkdirSync(inner, { recursive: true });
    const copy = path.join(inner, "database.sqlite");
    fs.writeFileSync(copy, payload);
    for (const entry of [copy, inner, container, parent]) {
      fs.utimesSync(entry, stale, stale);
    }
    return parent;
  });
  const receiptSource = `${fixtureReceiptClientSource(receipts.endpoint)}
    sendReceipt(${JSON.stringify(marker)}, "entered");
    fixtureReceiptSocket.ref();
    await new Promise((resolve) => fixtureReceiptSocket.end(resolve));
  `;
  fs.writeFileSync(
    harness,
    `
    import fs from 'node:fs';
    import path from 'node:path';
    import { Worker } from 'node:worker_threads';
    import { DatabaseSync } from 'node:sqlite';
    if (process.argv[3] === 'reclaim') {
      const remove = fs.rmSync;
      let entered = false;
      fs.rmSync = (file, options) => {
        const relative = path.relative(path.toNamespacedPath(${JSON.stringify(cache)}), path.toNamespacedPath(path.resolve(String(file))));
        if (!entered && !relative.startsWith('..') && !path.isAbsolute(relative) && path.basename(String(file)) === 'database.sqlite') {
          entered = true;
          fs.writeFileSync(${JSON.stringify(`${marker}.partial`)}, JSON.stringify({
            claimedRoot: path.join(${JSON.stringify(cache)}, relative.split(path.sep)[0]), file: String(file),
          }));
          fs.renameSync(${JSON.stringify(`${marker}.partial`)}, ${JSON.stringify(marker)});
          // The relay flushes the receipt while this thread blocks at the native gate.
          new Worker(new URL(${JSON.stringify(`data:text/javascript,${encodeURIComponent(receiptSource)}`)}), { execArgv: [] }).unref();
          const gate = new DatabaseSync(${JSON.stringify(gatePath)});
          try { gate.exec('PRAGMA busy_timeout=10000; BEGIN IMMEDIATE; ROLLBACK;'); }
          finally { gate.close(); }
        }
        return remove(file, options);
      };
    }
    await import(${JSON.stringify(new URL("./sqlite-readonly-location.worker.ts", import.meta.url).href)});
    `,
  );
  vi.stubEnv("XDG_CACHE_HOME", cacheHome);
  vi.spyOn(workerUrls, "resolveRuntimeWorkerUrl").mockReturnValue(pathToFileURL(harness));
  const entered = async (
    operation: Promise<unknown>,
  ): Promise<{ claimedRoot: string; file: string }> => {
    const settled = operation.then(
      () => {
        if (!fs.existsSync(marker)) {
          throw new Error(
            `Reclaimer did not reach the directory gate: ${workers.get(path.resolve(cache))?.stderr ?? "no child stderr"}`,
          );
        }
      },
      (error: unknown) => {
        if (!fs.existsSync(marker)) {
          throw error;
        }
      },
    );
    await Promise.race([receipts.waitFor(marker, "entered"), settled]);
    return JSON.parse(fs.readFileSync(marker, "utf8"));
  };
  const release = () => {
    if (gate.isTransaction) {
      gate.exec("ROLLBACK");
    }
  };
  return {
    cache,
    source,
    roots,
    entered,
    release,
    worker() {
      const worker = workers.get(path.resolve(cache));
      if (!worker) {
        throw new Error("Reclaim child was not observed");
      }
      return worker;
    },
    close() {
      release();
      gate.close();
    },
  };
}

async function readSnapshot(source: string, signal?: AbortSignal): Promise<void> {
  const prepared = await prepareSqliteReadOnlyLocation(source, { signal });
  try {
    // Windows test homes can put the prepared snapshot at the native path limit.
    const db = openNodeSqliteDatabase(prepared.location, { readOnly: true });
    try {
      expect(db.prepare("SELECT value FROM probe").get()).toEqual({ value: "preserved" });
    } finally {
      db.close();
    }
  } finally {
    expect(await prepared.cleanupAsync()).toBe(true);
  }
}

it("keeps cancelled and surviving callers independent of idle reclamation", async ({ signal }) => {
  for (const mode of ["snapshot", "update"] as const) {
    const f = mode === "snapshot" ? fixture(64, 4 * 1024 * 1024) : fixture();
    const controller = new AbortController();
    const reason = new DOMException(`${mode} caller stopped`, "AbortError");
    const reclamation = reclaimAbandonedSqliteSnapshotsAsync(f.cache);
    let operation: Promise<unknown> | undefined;
    let survivor: Promise<void> | undefined;
    try {
      const entered = await withinTest(f.entered(reclamation), signal);
      operation = withSqliteReadOnlyWorkerScope(async () => {
        if (mode === "snapshot") {
          await readSnapshot(f.source, controller.signal);
        } else {
          await readUpdateStateSchemaVersions({
            stateDir: path.dirname(f.source),
            config: {},
            signal: controller.signal,
          });
        }
      }).then(
        () => undefined,
        (error: unknown) => error,
      );
      if (mode === "snapshot") {
        survivor = readSnapshot(f.source);
      }
      controller.abort(reason);
      const error = await withinTest(operation, signal);
      // Cancellation must settle while reclamation is still held at the native gate.
      expect(error).toBe(reason);
      expect(error).toMatchObject({ name: "AbortError" });
      expect(f.worker().settled, mode).toBe(false);
      expect(fs.existsSync(entered.file), mode).toBe(true);
      await survivor;
      expect(f.worker().settled, mode).toBe(false);
      f.release();
      await reclamation;
      await f.worker().closed;
      expect(fs.existsSync(entered.claimedRoot)).toBe(false);
      expect(f.worker().child.exitCode).toBe(0);
      expect(f.worker().child.signalCode).toBeNull();
      expect(fs.readdirSync(f.cache)).toEqual([]);
    } finally {
      controller.abort(reason);
      f.release();
      await Promise.allSettled([operation, survivor]);
      await reclamation;
      await workers.get(path.resolve(f.cache))?.closed;
      f.close();
    }
  }
});

it("stops idle reclamation at the next directory boundary on shutdown", async ({ signal }) => {
  const f = fixture();
  const reclamation = reclaimAbandonedSqliteSnapshotsAsync(f.cache);
  let shutdown: Promise<void> | undefined;
  try {
    const entered = await withinTest(f.entered(reclamation), signal);
    // Payload removal precedes the rename, so identify the fenced root directly.
    const untouched = f.roots.filter((root) => root !== entered.claimedRoot && fs.existsSync(root));
    expect(f.roots).toContain(entered.claimedRoot);
    expect(untouched).toHaveLength(f.roots.length - 1);
    const stdin = f.worker().child.stdin;
    if (!stdin) {
      throw new Error("Reclaim child stdin was not observed");
    }
    const ended = once(stdin, "finish");
    shutdown = waitForSignalExitBarriers();
    await withinTest(ended, signal);
    expect(stdin.writableEnded).toBe(true);
    expect(f.worker().settled).toBe(false);
    f.release();
    await shutdown;
    await reclamation;
    await f.worker().closed;
    expect(f.worker().child.exitCode).toBe(0);
    expect(f.worker().child.signalCode).toBeNull();
    expect(fs.existsSync(entered.claimedRoot)).toBe(false);
    expect(f.roots.filter((root) => fs.existsSync(root))).toEqual(untouched);
    for (const root of untouched) {
      expect(fs.readdirSync(root)).toEqual(["openclaw"]);
    }
    // A foreground read must not resume the idle pass it does not own.
    await readSnapshot(f.source);
    expect(f.roots.filter((root) => fs.existsSync(root))).toEqual(untouched);
  } finally {
    f.release();
    await Promise.allSettled([reclamation, shutdown]);
    await workers.get(path.resolve(f.cache))?.closed;
    f.close();
  }
});
