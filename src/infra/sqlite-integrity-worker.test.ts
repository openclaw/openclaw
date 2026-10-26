import { AsyncResource } from "node:async_hooks";
import { ChildProcess, fork } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { openNodeSqliteDatabase, requireNodeSqlite } from "./node-sqlite.js";
import * as processUrls from "./runtime-process-url.js";
import { readSqliteDatabaseIntegrityVerification } from "./sqlite-database-admission.js";
import { runSqliteIntegrityOperationInWorker } from "./sqlite-integrity-operation.js";
import { SqliteIntegrityWorkerInterruptedError } from "./sqlite-integrity-worker-error.js";
import {
  assertSqliteIntegrityInWorker,
  withSqliteIntegrityWorkerScope,
} from "./sqlite-integrity-worker.js";
import { sqliteIntegrityCheckSteps, type SqliteIntegrityCheckTiming } from "./sqlite-integrity.js";
import * as inspectionBudget from "./sqlite-readonly-worker.js";

const progress = vi.hoisted(() => vi.fn());
vi.mock("../logging/subsystem.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../logging/subsystem.js")>();
  return {
    ...actual,
    createSubsystemLogger: (subsystem: string) => ({
      ...actual.createSubsystemLogger(subsystem),
      ...(subsystem === "state/sqlite" ? { info: progress } : {}),
    }),
  };
});

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, fork: vi.fn(actual.fork) };
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const { fork: nativeFork } =
  await vi.importActual<typeof import("node:child_process")>("node:child_process");

function fixture(
  prefix: string,
  sql?: string,
  prepare?: (database: import("node:sqlite").DatabaseSync) => void,
) {
  const root = tempDirs.make(`openclaw-integrity-${prefix}-`);
  const source = path.join(root, "source.sqlite");
  if (sql === undefined) {
    fs.writeFileSync(source, "retained source");
  } else {
    const db = new (requireNodeSqlite().DatabaseSync)(source);
    try {
      db.exec(sql);
      prepare?.(db);
    } finally {
      db.close();
    }
  }
  return { root, source };
}

function inspect(
  source: string,
  signal = new AbortController().signal,
  timing?: SqliteIntegrityCheckTiming,
) {
  return assertSqliteIntegrityInWorker(source, 250, signal, undefined, timing);
}

function inScope<T>(run: () => Promise<T>) {
  return withSqliteIntegrityWorkerScope(() => {}, run);
}

function useWorker(root: string, program: string, name = "worker.mjs") {
  const worker = path.join(root, name);
  fs.writeFileSync(worker, program);
  vi.spyOn(processUrls, "resolveRuntimeProcessEntrypointUrl").mockReturnValue(
    pathToFileURL(worker),
  );
}

function expectForksClosed() {
  expect(fork).toHaveBeenCalledOnce();
  for (const result of vi.mocked(fork).mock.results) {
    expect(result).toMatchObject({ type: "return", value: { exitCode: 0 } });
  }
}

function expectElapsed(value: unknown) {
  expect(value).toEqual(expect.any(Number));
  expect(Number.isFinite(value)).toBe(true);
  expect(value).toBeGreaterThanOrEqual(0);
}

describe("SQLite integrity child", () => {
  afterEach(() => vi.restoreAllMocks());
  it("does not publish a quick worker result as full integrity verification", async () => {
    const source = path.join(tempDirs.make("openclaw-integrity-receipt-"), "source.sqlite");
    using database = openNodeSqliteDatabase(source);
    database.exec("CREATE TABLE records(value INTEGER); INSERT INTO records VALUES(1)");
    const options = {
      busyTimeoutMs: 250,
      signal: new AbortController().signal,
      beforeResume: () => {},
    };
    await runSqliteIntegrityOperationInWorker(
      sqliteIntegrityCheckSteps(database, source, undefined, {
        check: "quick",
        tables: ["records"],
      }),
      options,
    );
    expect(readSqliteDatabaseIntegrityVerification(database)).toBeUndefined();
    await runSqliteIntegrityOperationInWorker(
      sqliteIntegrityCheckSteps(database, source, undefined, { check: "full" }),
      options,
    );
    expect(readSqliteDatabaseIntegrityVerification(database)?.verifiedAt).toEqual(
      expect.any(Number),
    );
  });

  it("reports bounded progress while native integrity is blocked and stops after cancellation", async () => {
    const { source } = fixture("progress");
    progress.mockClear();
    const worker = new ChildProcess();
    worker.send = vi.fn(() => true);
    worker.kill = vi.fn(() => {
      queueMicrotask(() => worker.emit("close", null, "SIGKILL"));
      return true;
    });
    vi.mocked(fork).mockReturnValueOnce(worker);
    const controller = new AbortController();
    vi.useFakeTimers();
    try {
      const check = inScope(() => inspect(source, controller.signal));
      await vi.advanceTimersByTimeAsync(0);
      worker.emit("message", { type: "phase", phase: "checking" });
      await vi.advanceTimersByTimeAsync(30_000);
      expect(progress).toHaveBeenCalledTimes(3);
      expect(progress).toHaveBeenCalledWith(expect.stringContaining("phase=checking"));
      const outcome = expect(check).rejects.toThrow("interrupted inspection");
      controller.abort(new Error("interrupted inspection"));
      await vi.advanceTimersByTimeAsync(0);
      await outcome;
      await vi.advanceTimersByTimeAsync(30_000);
      expect(progress).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });
  it("closes the native reader after reporting structural damage", async () => {
    let fragmentCountOffset = 0;
    const { source } = fixture(
      "file",
      "CREATE TABLE records(value INTEGER); INSERT INTO records VALUES(1)",
      (database) => {
        const root = Number(
          database.prepare("SELECT rootpage FROM sqlite_schema WHERE name = 'records'").get()
            ?.rootpage,
        );
        const pageSize = Number(database.prepare("PRAGMA page_size").get()?.page_size);
        fragmentCountOffset = (root - 1) * pageSize + 7;
      },
    );
    // Misreport free-byte fragmentation without making the records themselves unreadable.
    const bytes = fs.readFileSync(source);
    bytes.writeUInt8(1, fragmentCountOffset);
    fs.writeFileSync(source, bytes);
    const timing: SqliteIntegrityCheckTiming = {};
    vi.mocked(fork).mockClear();
    const check = inScope(() => inspect(source, undefined, timing));
    await expect(check).rejects.toMatchObject({
      name: "SqliteIntegrityError",
      message: expect.stringMatching(
        /integrity_check failed[\s\S]*Fragmentation of 0 bytes reported as 1/u,
      ),
    });
    expectForksClosed();
  });

  it("reports a SIGTERM close without an integrity verdict as an interruption", async () => {
    const { source } = fixture("signal");
    const worker = new ChildProcess();
    worker.send = vi.fn(() => {
      queueMicrotask(() => worker.emit("close", null, "SIGTERM"));
      return true;
    });
    vi.mocked(fork).mockReturnValueOnce(worker);
    const failure = await inspect(source).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(SqliteIntegrityWorkerInterruptedError);
    expect(failure).toMatchObject({ signal: "SIGTERM" });
    expect(failure).not.toMatchObject({ name: "SqliteIntegrityError" });
    expect(fs.readFileSync(source, "utf8")).toBe("retained source");
  });

  it("budgets integrity for committed WAL data while its writer remains open", async () => {
    const source = path.join(tempDirs.make("openclaw-integrity-wal-budget-"), "source.sqlite");
    const writer = new (requireNodeSqlite().DatabaseSync)(source);
    try {
      writer.exec(
        "PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE padding (data BLOB)",
      );
      writer.prepare("INSERT INTO padding VALUES (zeroblob(?))").run(32 * 1024 * 1024);
      expect(fs.statSync(source).size).toBeLessThan(32 * 1024);
      expect(fs.statSync(`${source}-wal`).size).toBeGreaterThan(32 * 1024 * 1024);
      vi.mocked(fork).mockClear();

      await expect(inspect(source)).resolves.toBeUndefined();

      expect(fork).toHaveBeenCalledExactlyOnceWith(
        expect.any(URL),
        [],
        expect.objectContaining({ timeout: 341_000, killSignal: "SIGKILL" }),
      );
    } finally {
      writer.close();
    }
  });

  it.each([
    { reuse: false, cancel: false },
    { reuse: true, cancel: false },
    { reuse: true, cancel: true },
  ])(
    "joins a stuck scan before releasing ownership (reused=$reuse, cancelled=$cancel)",
    async ({ reuse, cancel }) => {
      const { root, source } = fixture("timeout");
      const ready = path.join(root, "ready");
      useWorker(
        root,
        `import fs from 'node:fs';
      process.on('SIGTERM', () => {});
      process.on('message', () => {
        fs.writeFileSync(${JSON.stringify(ready)}, 'ready');
        process.send({ type: 'phase', phase: 'checking' });
      });
      setTimeout(() => process.exit(0), 35000);`,
      );
      let childClosed: Promise<void> | undefined;
      let closeSignal: NodeJS.Signals | null | undefined;
      const controller = new AbortController();
      // Keep native IPC, timeout, and close behavior while shortening only the test wait.
      vi.mocked(fork).mockImplementationOnce((modulePath, args, options) => {
        expect(options).toMatchObject({
          timeout: reuse ? undefined : 301_000,
          killSignal: "SIGKILL",
        });
        const child = nativeFork(
          modulePath,
          args,
          reuse ? options : { ...options, timeout: 2_000 },
        );
        childClosed = new Promise<void>((resolve) => {
          child.once("close", (_code, signal) => {
            closeSignal = signal;
            resolve();
          });
        });
        if (cancel) {
          child.once("message", () =>
            controller.abort(new Error("synthetic active maintenance abort")),
          );
        }
        return child;
      });
      if (reuse) {
        vi.spyOn(inspectionBudget, "readSqliteInspectionBudget").mockReturnValue({
          timeoutMs: 2_000,
          size: "15 B",
        });
      }
      const started = performance.now();
      try {
        const run = () =>
          inspect(source, controller.signal).finally(() => {
            // Ownership must end after close, not merely after requesting termination.
            expect(closeSignal).toBe("SIGKILL");
          });
        await expect(reuse ? inScope(run) : run()).rejects.toThrow(
          cancel
            ? "synthetic active maintenance abort"
            : `SQLite integrity check timed out after ${reuse ? 2 : 301} seconds (budget for 15 B) for ${source}. Stop the Gateway service and other OpenClaw processes using this database, then retry; if already stopped, check storage performance. (lastObservedPhase=checking)`,
        );
        expect(performance.now() - started).toBeLessThan(8_000);
        expect(fs.readFileSync(ready, "utf8")).toBe("ready");
        expect(fs.readFileSync(source, "utf8")).toBe("retained source");
      } finally {
        await childClosed;
        vi.mocked(fork).mockReset().mockImplementation(nativeFork);
      }
    },
    10_000,
  );

  it.each([
    { priorError: false, failedResult: false },
    { priorError: true, failedResult: false },
    { priorError: false, failedResult: true },
  ])(
    "settles a deadline racing buffered IPC and real normal exit (prior error=$priorError, failed result=$failedResult)",
    async ({ priorError, failedResult }) => {
      const { root, source } = fixture(
        "deadline-exit",
        `
        CREATE TABLE parents (id INTEGER PRIMARY KEY);
        CREATE TABLE retained (parent_id INTEGER REFERENCES parents(id));
        ${failedResult ? "PRAGMA foreign_keys=OFF; INSERT INTO retained VALUES (42); PRAGMA foreign_keys=ON;" : ""}
      `,
      );
      useWorker(
        root,
        `import { DatabaseSync } from 'node:sqlite';
        process.once('message', ({ pathname }) => {
          const database = new DatabaseSync(pathname, { readOnly: true });
          const result = database.prepare('PRAGMA foreign_key_check').get();
          database.close();
          process.send({ type: 'phase', phase: 'closing' }, () => {
            const verdict = result
              ? { ok: false, error: { name: 'SqliteIntegrityError', message: 'foreign_key_check failed for ' + result.table } }
              : { ok: true };
            process.send(verdict, () => process.disconnect());
          });
        });`,
      );
      const nativeClosed = createDeferred();
      const resultReceived = createDeferred<unknown>();
      let withheldResult: (() => void) | undefined;
      let withheldClose: (() => void) | undefined;
      let child: ChildProcess | undefined;
      let closeDelivered = false;
      vi.mocked(fork).mockImplementationOnce((modulePath, args, options) => {
        const launched = nativeFork(modulePath, args, options);
        child = launched;
        const emit = launched.emit.bind(launched);
        // Delay real completion callbacks without inventing a live child's exit.
        vi.spyOn(launched, "emit").mockImplementation((event, ...eventArgs) => {
          const message = eventArgs[0];
          if (
            event === "message" &&
            typeof message === "object" &&
            message !== null &&
            "ok" in message
          ) {
            withheldResult = () => emit(event, ...eventArgs);
            resultReceived.resolve(message);
            return true;
          }
          if (event === "close") {
            withheldClose = () => {
              closeDelivered = true;
              emit(event, ...eventArgs);
            };
            nativeClosed.resolve();
            return true;
          }
          return emit(event, ...eventArgs);
        });
        launched.once("error", (error) => {
          nativeClosed.reject(error);
          resultReceived.reject(error);
        });
        return launched;
      });
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const check = inScope(() =>
        inspect(source).finally(() => {
          expect(closeDelivered).toBe(true);
        }),
      );
      const outcome = check.catch((error: unknown) => error);
      const original = new Error("synthetic recorded IPC failure");
      const failedError = {
        name: "SqliteIntegrityError",
        message: "foreign_key_check failed for retained",
      };
      try {
        const [verdict] = await Promise.all([resultReceived.promise, nativeClosed.promise]);
        expect(verdict).toMatchObject(
          failedResult ? { ok: false, error: failedError } : { ok: true },
        );
        const completed = expectDefined(child, "completed integrity child");
        expect(completed).toMatchObject({ exitCode: 0, signalCode: null });
        const kill = vi.spyOn(completed, "kill");
        if (priorError) {
          completed.emit("error", original);
        }
        if (failedResult) {
          expectDefined(withheldResult, "completed integrity verdict")();
          withheldResult = undefined;
        }
        vi.advanceTimersByTime(301_000);
        expect(kill).toHaveBeenCalledWith("SIGKILL");
        expect(kill.mock.results.every((result) => result.type === "return" && !result.value)).toBe(
          true,
        );
        withheldResult?.();
        withheldResult = undefined;
        expectDefined(withheldClose, "completed native exit")();
        withheldClose = undefined;
        if (priorError) {
          await expect(outcome).resolves.toBe(original);
        } else if (failedResult) {
          await expect(outcome).resolves.toMatchObject(failedError);
        } else {
          await expect(outcome).resolves.toMatchObject({
            message: expect.stringMatching(/integrity check timed out.*lastObservedPhase=closing/),
          });
        }
      } finally {
        vi.useRealTimers();
        withheldResult?.();
        withheldClose?.();
        await check.catch(() => undefined);
      }
    },
  );

  it.each<{
    messages: string;
    completes: boolean;
    checkMs?: number;
    errorMessage?: string;
  }>([
    { messages: '[{ type: "phase", phase: "checking" }]', completes: false },
    { messages: '[{ type: "phase", phase: "checking" }, { ok: true }]', completes: true },
    { messages: '[{ ok: true }, { type: "phase", phase: "closing" }]', completes: true },
    { messages: "[{ ok: true, checkElapsedMs: 0 }]", completes: true, checkMs: 0 },
    ...["-1", "NaN", '"4.75"'].map((invalid) => ({
      messages: `[{ ok: true, checkElapsedMs: ${invalid} }]`,
      completes: true,
    })),
    {
      messages:
        '[{ ok: false, error: { name: "SyntheticCheckError", message: "synthetic check failed" }, checkElapsedMs: 4.75 }]',
      completes: false,
      checkMs: 4.75,
      errorMessage: "synthetic check failed",
    },
  ])(
    "waits for close and preserves the verdict independently of optional timing: $messages",
    async ({ messages, completes, checkMs, errorMessage }) => {
      const { root, source } = fixture("protocol");
      useWorker(
        root,
        `process.once('message', async () => {
        process.once('message', () => process.disconnect());
        for (const message of ${messages}) {
          await new Promise((resolve, reject) => process.send(message, error => error ? reject(error) : resolve()));
        }
        process.send({ type: 'test-ready' });
      });`,
      );
      let child: ChildProcess | undefined;
      const childClosed = createDeferred();
      const ready = createDeferred();
      vi.mocked(fork).mockImplementationOnce((modulePath, args, options) => {
        const launched = nativeFork(modulePath, args, options);
        child = launched;
        launched.once("close", () => childClosed.resolve());
        launched.once("error", ready.reject);
        launched.once("close", () => ready.reject(new Error("Protocol child closed before ready")));
        launched.on("message", (message) => {
          if (
            typeof message === "object" &&
            message !== null &&
            "type" in message &&
            message.type === "test-ready"
          ) {
            ready.resolve();
          }
        });
        return launched;
      });
      const timing: SqliteIntegrityCheckTiming = {};
      const check = inspect(source, undefined, timing);
      let settled = false;
      const markSettled = () => {
        settled = true;
      };
      void check.then(markSettled, markSettled);
      try {
        await ready.promise;
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        expect(settled).toBe(false);
        expect(timing).not.toHaveProperty("workerLifetimeElapsedMs");
      } finally {
        child?.send("close", () => {});
        await childClosed.promise;
      }
      if (completes) {
        await expect(check).resolves.toBeUndefined();
      } else {
        await expect(check).rejects.toThrow(
          errorMessage ?? /without a completed check.*lastObservedPhase=checking/,
        );
      }
      expectElapsed(timing.workerLifetimeElapsedMs);
      if (checkMs === undefined) {
        expect(timing).not.toHaveProperty("workerCheckElapsedMs");
      } else {
        expect(timing.workerCheckElapsedMs).toBe(checkMs);
      }
    },
  );

  it("joins a queued cancellation and rejects callbacks inherited from a closed maintenance scope", async () => {
    const { source } = fixture(
      "queue",
      "CREATE TABLE retained (value TEXT); INSERT INTO retained VALUES ('data');",
    );
    const abort = new AbortController();
    let late: (() => Promise<void>) | undefined;
    vi.mocked(fork).mockClear();
    await inScope(async () => {
      const first = inspect(source);
      const queued = inspect(source, abort.signal);
      const rejected = expect(queued).rejects.toThrow("queued maintenance cancelled");
      abort.abort(new Error("queued maintenance cancelled"));
      await first;
      await rejected;
      expectForksClosed();
      late = AsyncResource.bind(() => inspect(source));
    });
    await expect(late?.()).rejects.toThrow("maintenance scope is closed");
    expect(fork).toHaveBeenCalledOnce();
  });

  it.each(["diagnostic", "open", "close"] as const)(
    "preserves error, timing and native close ownership after a %s failure",
    async (failure) => {
      const failOpen = failure === "open";
      const failNativeClose = failure === "close";
      const { root, source } = fixture(
        "native",
        "PRAGMA foreign_keys = OFF; CREATE TABLE parent(id INTEGER PRIMARY KEY); CREATE TABLE child(parent_id INTEGER REFERENCES parent(id)); INSERT INTO child VALUES (42);",
      );
      const entry = processUrls.resolveRuntimeProcessEntrypointUrl("sqliteIntegrity");
      const closed = path.join(root, "closed.json");
      const resultPath = path.join(root, "result.json");
      useWorker(
        root,
        `import fs from 'node:fs';
        import { createRequire } from 'node:module';
        const sqlite = createRequire(import.meta.url)('node:sqlite');
        let initialTimeout;
        sqlite.DatabaseSync = new Proxy(sqlite.DatabaseSync, {
          construct(target, args) {
            if (${failOpen} && args[0] === ${JSON.stringify(source)}) {
              throw Object.assign(new Error('synthetic native open failure'), { code: 'SQLITE_CANTOPEN', errcode: 14 });
            }
            const database = Reflect.construct(target, args);
            if (args[0] === ${JSON.stringify(source)}) {
              initialTimeout = database.prepare('PRAGMA busy_timeout').get().timeout;
            }
            return database;
          },
        });
        const close = sqlite.DatabaseSync.prototype.close;
        sqlite.DatabaseSync.prototype.close = function (...args) {
          const location = this.prepare('PRAGMA database_list').all().find(row => row.name === 'main').file;
          if (${failNativeClose} && location === ${JSON.stringify(source)}) throw new Error('synthetic native close failure');
          const result = Reflect.apply(close, this, args);
          if (location === ${JSON.stringify(source)}) fs.writeFileSync(${JSON.stringify(closed)}, JSON.stringify({ isOpen: this.isOpen }));
          return result;
        };
        const send = process.send.bind(process);
        process.send = (message, ...args) => {
          if (${failure === "diagnostic"} && message.type === 'phase' && message.phase === 'closing') throw new Error('synthetic diagnostic send failure');
          if ('ok' in message) fs.writeFileSync(${JSON.stringify(resultPath)}, JSON.stringify({ ...message, initialTimeout }));
          return send(message, ...args);
        };
        await import(${JSON.stringify(entry.href)});`,
        "observed-worker.mts",
      );
      const timing: SqliteIntegrityCheckTiming = {};
      const expectedError = failNativeClose
        ? { message: "synthetic native close failure" }
        : failOpen
          ? { message: "synthetic native open failure", code: "SQLITE_CANTOPEN", errcode: 14 }
          : {
              name: "SqliteIntegrityError",
              message: expect.stringContaining("foreign_key_check failed"),
            };
      const run = () => inspect(source, undefined, timing);
      await expect(failNativeClose ? inScope(run) : run()).rejects.toMatchObject(expectedError);
      const child = vi.mocked(fork).mock.results.at(-1)?.value as ReturnType<typeof fork>;
      expect(child.exitCode).toBe(0);
      const result = JSON.parse(fs.readFileSync(resultPath, "utf8"));
      expect(result.initialTimeout).toBe(failOpen ? undefined : 250);
      if (failOpen) {
        expect(fs.existsSync(closed)).toBe(false);
        expect(result).not.toHaveProperty("checkElapsedMs");
        expect(timing).not.toHaveProperty("workerCheckElapsedMs");
      } else {
        if (failNativeClose) {
          expect(fs.existsSync(closed)).toBe(false);
        } else {
          expect(JSON.parse(fs.readFileSync(closed, "utf8"))).toEqual({ isOpen: false });
        }
        expectElapsed(result.checkElapsedMs);
        expect(timing.workerCheckElapsedMs).toBe(result.checkElapsedMs);
      }
      expect(timing.workerLifetimeElapsedMs).toEqual(expect.any(Number));
    },
  );
});
