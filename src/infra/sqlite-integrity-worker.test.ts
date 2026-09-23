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
import { requireNodeSqlite } from "./node-sqlite.js";
import * as processUrls from "./runtime-process-url.js";
import { SqliteIntegrityWorkerInterruptedError } from "./sqlite-integrity-worker-error.js";
import {
  assertSqliteIntegrityInWorker,
  withSqliteIntegrityWorkerScope,
} from "./sqlite-integrity-worker.js";
import type { SqliteIntegrityCheckTiming } from "./sqlite-integrity.js";
import * as inspectionBudget from "./sqlite-readonly-worker.js";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, fork: vi.fn(actual.fork) };
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("SQLite integrity child", () => {
  afterEach(() => vi.restoreAllMocks());
  it("reports a SIGTERM close without an integrity verdict as an interruption", async () => {
    const root = tempDirs.make("openclaw-integrity-signal-");
    const source = path.join(root, "source.sqlite");
    fs.writeFileSync(source, "retained source");
    const worker = new ChildProcess();
    worker.send = vi.fn(() => {
      queueMicrotask(() => worker.emit("close", null, "SIGTERM"));
      return true;
    });
    vi.mocked(fork).mockReturnValueOnce(worker);
    const failure = await assertSqliteIntegrityInWorker(
      source,
      250,
      new AbortController().signal,
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(SqliteIntegrityWorkerInterruptedError);
    expect(failure).toMatchObject({ signal: "SIGTERM" });
    expect(failure).not.toMatchObject({ name: "SqliteIntegrityError" });
    expect(fs.readFileSync(source, "utf8")).toBe("retained source");
  });

  it.each([
    { label: "empty", paddingBytes: null, minimumSize: 0, maximumSize: 0, timeout: 300_000 },
    {
      label: "small",
      paddingBytes: 0,
      minimumSize: 1,
      maximumSize: 32 * 1024 * 1024,
      timeout: 301_000,
    },
    {
      label: "over 64 MiB",
      paddingBytes: 64 * 1024 * 1024,
      minimumSize: 64 * 1024 * 1024 + 1,
      maximumSize: 96 * 1024 * 1024,
      timeout: 381_000,
    },
  ])(
    "starts the child with the size budget for a $label database",
    async ({ paddingBytes, minimumSize, maximumSize, timeout }) => {
      const source = path.join(tempDirs.make("openclaw-integrity-budget-"), "source.sqlite");
      const db = new (requireNodeSqlite().DatabaseSync)(source);
      try {
        if (paddingBytes !== null) {
          db.exec("CREATE TABLE padding (data BLOB)");
          db.prepare("INSERT INTO padding VALUES (zeroblob(?))").run(paddingBytes);
        }
      } finally {
        db.close();
      }
      const size = fs.statSync(source).size;
      expect(size).toBeGreaterThanOrEqual(minimumSize);
      expect(size).toBeLessThanOrEqual(maximumSize);
      vi.mocked(fork).mockClear();

      await expect(
        assertSqliteIntegrityInWorker(source, 250, new AbortController().signal),
      ).resolves.toBeUndefined();

      expect(fork).toHaveBeenCalledExactlyOnceWith(
        expect.any(URL),
        [],
        expect.objectContaining({ timeout, killSignal: "SIGKILL" }),
      );
    },
  );

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

      await expect(
        assertSqliteIntegrityInWorker(source, 250, new AbortController().signal),
      ).resolves.toBeUndefined();

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
      const root = tempDirs.make("openclaw-integrity-timeout-");
      const source = path.join(root, "source.sqlite");
      fs.writeFileSync(source, "retained source");
      const worker = path.join(root, "blocked.mjs");
      const ready = path.join(root, "ready");
      fs.writeFileSync(
        worker,
        `import fs from 'node:fs';
      process.on('SIGTERM', () => {});
      process.on('message', () => {
        fs.writeFileSync(${JSON.stringify(ready)}, 'ready');
        process.send({ type: 'phase', phase: 'checking' });
      });
      setTimeout(() => process.exit(0), 35000);`,
      );
      vi.spyOn(processUrls, "resolveRuntimeProcessEntrypointUrl").mockReturnValue(
        pathToFileURL(worker),
      );
      const actual =
        await vi.importActual<typeof import("node:child_process")>("node:child_process");
      let childClosed: Promise<void> | undefined;
      let closeSignal: NodeJS.Signals | null | undefined;
      const controller = new AbortController();
      // Keep native IPC, timeout, and close behavior while shortening only the test wait.
      vi.mocked(fork).mockImplementationOnce((modulePath, args, options) => {
        expect(options).toMatchObject({
          timeout: reuse ? undefined : 301_000,
          killSignal: "SIGKILL",
        });
        const child = actual.fork(
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
        const inspect = () =>
          assertSqliteIntegrityInWorker(source, 250, controller.signal).finally(() => {
            // Ownership must end after close, not merely after requesting termination.
            expect(closeSignal).toBe("SIGKILL");
          });
        await expect(
          reuse ? withSqliteIntegrityWorkerScope(() => {}, inspect) : inspect(),
        ).rejects.toThrow(
          cancel
            ? "synthetic active maintenance abort"
            : `SQLite integrity check timed out after ${reuse ? 2 : 301} seconds (budget for 15 B) for ${source}. Stop the Gateway service and other OpenClaw processes using this database, then retry; if already stopped, check storage performance. (lastObservedPhase=checking)`,
        );
        expect(performance.now() - started).toBeLessThan(8_000);
        expect(fs.readFileSync(ready, "utf8")).toBe("ready");
        expect(fs.readFileSync(source, "utf8")).toBe("retained source");
      } finally {
        await childClosed;
        vi.mocked(fork).mockReset().mockImplementation(actual.fork);
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
      const root = tempDirs.make("openclaw-integrity-deadline-exit-");
      const source = path.join(root, "source.sqlite");
      const database = new (requireNodeSqlite().DatabaseSync)(source);
      database.exec(
        "CREATE TABLE parents (id INTEGER PRIMARY KEY); CREATE TABLE retained (parent_id INTEGER REFERENCES parents(id));",
      );
      if (failedResult) {
        database.exec(
          "PRAGMA foreign_keys=OFF; INSERT INTO retained VALUES (42); PRAGMA foreign_keys=ON;",
        );
        expect(database.prepare("PRAGMA foreign_key_check").get()).toEqual({
          table: "retained",
          rowid: 1,
          parent: "parents",
          fkid: 0,
        });
      }
      database.close();
      const worker = path.join(root, "completed.mjs");
      fs.writeFileSync(
        worker,
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
      vi.spyOn(processUrls, "resolveRuntimeProcessEntrypointUrl").mockReturnValue(
        pathToFileURL(worker),
      );
      const actual =
        await vi.importActual<typeof import("node:child_process")>("node:child_process");
      const nativeClosed = createDeferred();
      const resultReceived = createDeferred<unknown>();
      let withheldResult: (() => void) | undefined;
      let withheldClose: (() => void) | undefined;
      let child: ChildProcess | undefined;
      let closeDelivered = false;
      vi.mocked(fork).mockImplementationOnce((modulePath, args, options) => {
        const launched = actual.fork(modulePath, args, options);
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
      const check = withSqliteIntegrityWorkerScope(
        () => {},
        () =>
          assertSqliteIntegrityInWorker(source, 250, new AbortController().signal).finally(() => {
            expect(closeDelivered).toBe(true);
          }),
      );
      const outcome = check.catch((error: unknown) => error);
      const original = new Error("synthetic recorded IPC failure");
      try {
        const [verdict] = await Promise.all([resultReceived.promise, nativeClosed.promise]);
        expect(verdict).toMatchObject(
          failedResult
            ? {
                ok: false,
                error: {
                  name: "SqliteIntegrityError",
                  message: "foreign_key_check failed for retained",
                },
              }
            : { ok: true },
        );
        const completed = expectDefined(child, "completed integrity child");
        expect(completed.exitCode).toBe(0);
        expect(completed.signalCode).toBeNull();
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
          await expect(outcome).resolves.toMatchObject({
            name: "SqliteIntegrityError",
            message: "foreign_key_check failed for retained",
          });
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
    { messages: "[{ ok: true, checkElapsedMs: 4.75 }]", completes: true, checkMs: 4.75 },
    ...["-1", "NaN", "Infinity", '"4.75"', "null"].map((invalid) => ({
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
    {
      messages:
        '[{ ok: false, error: { name: "SyntheticCheckError", message: "synthetic check failed" }, checkElapsedMs: NaN }]',
      completes: false,
      errorMessage: "synthetic check failed",
    },
  ])(
    "waits for close and preserves the verdict independently of optional timing: $messages",
    async ({ messages, completes, checkMs, errorMessage }) => {
      const root = tempDirs.make("openclaw-integrity-protocol-");
      const source = path.join(root, "source.sqlite");
      fs.writeFileSync(source, "retained source");
      const worker = path.join(root, "messages.mjs");
      fs.writeFileSync(
        worker,
        `process.once('message', async () => {
        process.once('message', () => process.disconnect());
        for (const message of ${messages}) {
          await new Promise((resolve, reject) => process.send(message, error => error ? reject(error) : resolve()));
        }
        process.send({ type: 'test-ready' });
      });`,
      );
      vi.spyOn(processUrls, "resolveRuntimeProcessEntrypointUrl").mockReturnValue(
        pathToFileURL(worker),
      );
      const actual =
        await vi.importActual<typeof import("node:child_process")>("node:child_process");
      let child: ReturnType<typeof fork> | undefined;
      let childClosed: Promise<void> | undefined;
      let ready: Promise<void> | undefined;
      vi.mocked(fork).mockImplementationOnce((modulePath, args, options) => {
        const launched = actual.fork(modulePath, args, options);
        child = launched;
        childClosed = new Promise((resolve) => {
          launched.once("close", () => resolve());
        });
        ready = new Promise((resolve, reject) => {
          launched.once("error", reject);
          launched.once("close", () => reject(new Error("Protocol child closed before ready")));
          launched.on("message", (message) => {
            if (
              typeof message === "object" &&
              message !== null &&
              "type" in message &&
              message.type === "test-ready"
            ) {
              resolve();
            }
          });
        });
        return launched;
      });
      const timing: SqliteIntegrityCheckTiming = {};
      const check = assertSqliteIntegrityInWorker(
        source,
        250,
        new AbortController().signal,
        undefined,
        timing,
      );
      let settled = false;
      void check.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      try {
        await ready;
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        expect(settled).toBe(false);
        expect(timing).not.toHaveProperty("workerLifetimeElapsedMs");
      } finally {
        child?.send("close", () => {});
        await childClosed;
      }
      if (completes) {
        await expect(check).resolves.toBeUndefined();
      } else {
        await expect(check).rejects.toThrow(
          errorMessage ?? /without a completed check.*lastObservedPhase=checking/,
        );
      }
      expect(timing.workerLifetimeElapsedMs).toEqual(expect.any(Number));
      expect(Number.isFinite(timing.workerLifetimeElapsedMs)).toBe(true);
      expect(timing.workerLifetimeElapsedMs).toBeGreaterThanOrEqual(0);
      if (checkMs === undefined) {
        expect(timing).not.toHaveProperty("workerCheckElapsedMs");
      } else {
        expect(timing.workerCheckElapsedMs).toBe(checkMs);
      }
    },
  );

  it("joins a queued cancellation and rejects callbacks inherited from a closed maintenance scope", async () => {
    const source = path.join(tempDirs.make("openclaw-integrity-queue-"), "source.sqlite");
    const database = new (requireNodeSqlite().DatabaseSync)(source);
    database.exec("CREATE TABLE retained (value TEXT); INSERT INTO retained VALUES ('data');");
    database.close();
    const abort = new AbortController();
    let late: (() => Promise<void>) | undefined;
    vi.mocked(fork).mockClear();
    await withSqliteIntegrityWorkerScope(
      () => {},
      async () => {
        const first = assertSqliteIntegrityInWorker(source, 250, new AbortController().signal);
        const queued = assertSqliteIntegrityInWorker(source, 250, abort.signal);
        const rejected = expect(queued).rejects.toThrow("queued maintenance cancelled");
        abort.abort(new Error("queued maintenance cancelled"));
        await first;
        await rejected;
        expect(fork).toHaveBeenCalledOnce();
        const result = expectDefined(
          vi.mocked(fork).mock.results[0],
          "queued integrity fork result",
        );
        if (result.type !== "return") {
          throw new Error("Integrity worker did not start");
        }
        expect(result.value.exitCode).toBe(0);
        late = AsyncResource.bind(() =>
          assertSqliteIntegrityInWorker(source, 250, new AbortController().signal),
        );
      },
    );
    await expect(late?.()).rejects.toThrow("maintenance scope is closed");
    expect(fork).toHaveBeenCalledOnce();
  });

  it.each([
    { failClosingPhase: false, failOpen: false, failNativeClose: false, reuse: false },
    { failClosingPhase: true, failOpen: false, failNativeClose: false, reuse: false },
    { failClosingPhase: false, failOpen: true, failNativeClose: false, reuse: false },
    { failClosingPhase: false, failOpen: false, failNativeClose: true, reuse: true },
  ])(
    "preserves error, timing and native close ownership: $failClosingPhase / $failOpen / $failNativeClose / $reuse",
    async ({ failClosingPhase, failOpen, failNativeClose, reuse }) => {
      const root = tempDirs.make("openclaw-integrity-native-");
      const source = path.join(root, "source.sqlite");
      const db = new (requireNodeSqlite().DatabaseSync)(source);
      db.exec(
        "PRAGMA foreign_keys = OFF; CREATE TABLE parent(id INTEGER PRIMARY KEY); CREATE TABLE child(parent_id INTEGER REFERENCES parent(id)); INSERT INTO child VALUES (42);",
      );
      db.close();
      const entry = processUrls.resolveRuntimeProcessEntrypointUrl("sqliteIntegrity");
      const phases = path.join(root, "phases.jsonl");
      const closed = path.join(root, "closed.json");
      const resultPath = path.join(root, "result.json");
      const worker = path.join(root, "observed-worker.mts");
      fs.writeFileSync(
        worker,
        `import fs from 'node:fs';
        import { createRequire } from 'node:module';
        const sqlite = createRequire(import.meta.url)('node:sqlite');
        sqlite.DatabaseSync = new Proxy(sqlite.DatabaseSync, {
          construct(target, args) {
            if (${failOpen} && args[0] === ${JSON.stringify(source)}) {
              throw Object.assign(new Error('synthetic native open failure'), { code: 'SQLITE_CANTOPEN', errcode: 14 });
            }
            return Reflect.construct(target, args);
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
          if (message.type === 'phase') {
            fs.appendFileSync(${JSON.stringify(phases)}, JSON.stringify(message.phase) + '\\n');
            if (${failClosingPhase} && message.phase === 'closing') throw new Error('synthetic diagnostic send failure');
          }
          if ('ok' in message) fs.writeFileSync(${JSON.stringify(resultPath)}, JSON.stringify(message));
          return send(message, ...args);
        };
        await import(${JSON.stringify(entry.href)});`,
      );
      vi.spyOn(processUrls, "resolveRuntimeProcessEntrypointUrl").mockReturnValue(
        pathToFileURL(worker),
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
      const inspect = () =>
        assertSqliteIntegrityInWorker(source, 250, new AbortController().signal, undefined, timing);
      await expect(
        reuse ? withSqliteIntegrityWorkerScope(() => {}, inspect) : inspect(),
      ).rejects.toMatchObject(expectedError);
      const child = vi.mocked(fork).mock.results.at(-1)?.value as ReturnType<typeof fork>;
      expect(child.exitCode).toBe(0);
      expect(fs.existsSync(phases)).toBe(true);
      expect(
        fs
          .readFileSync(phases, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line)),
      ).toEqual(failOpen ? ["opening"] : ["opening", "checking", "closing"]);
      const result = JSON.parse(fs.readFileSync(resultPath, "utf8"));
      expect(result).toMatchObject({ ok: false, error: expectedError });
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
        expect(result.checkElapsedMs).toEqual(expect.any(Number));
        expect(Number.isFinite(result.checkElapsedMs)).toBe(true);
        expect(result.checkElapsedMs).toBeGreaterThanOrEqual(0);
        expect(timing.workerCheckElapsedMs).toBe(result.checkElapsedMs);
      }
      expect(timing.workerLifetimeElapsedMs).toEqual(expect.any(Number));
    },
  );
});
