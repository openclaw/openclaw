import { isMainThread, threadId } from "node:worker_threads";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetLogger, setLoggerOverride } from "../logging/logger.js";
import { loggingState } from "../logging/state.js";
import { requireNodeSqlite } from "./node-sqlite.js";
import { withSqliteReaderOwner } from "./sqlite-reader-lifecycle.js";
import {
  logSlowSqliteCoordinatorWait,
  runSqliteDeferredTransactionSync,
  runSqliteImmediateTransactionSync,
} from "./sqlite-transaction.js";

const previousConsole = loggingState.rawConsole;

const openDatabases: Array<import("node:sqlite").DatabaseSync> = [];

function createDatabase(): import("node:sqlite").DatabaseSync {
  const { DatabaseSync } = requireNodeSqlite();
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE entries (id TEXT NOT NULL PRIMARY KEY, value TEXT NOT NULL)");
  openDatabases.push(db);
  return db;
}

function readEntries(db: import("node:sqlite").DatabaseSync) {
  return db
    .prepare("SELECT id FROM entries ORDER BY id")
    .all()
    .map((row) => row.id);
}

afterEach(() => {
  for (const db of openDatabases.splice(0)) {
    if (db.isOpen) {
      db.close();
    }
  }
  vi.restoreAllMocks();
  loggingState.rawConsole = previousConsole;
  setLoggerOverride(null);
  resetLogger();
});

describe("SQLite transaction diagnostics", () => {
  it.each(["explicit", "inherited", "unlabeled"] as const)(
    "logs one structured warning for a terminal lock failure (%s labels)",
    (labels) => {
      const execCalls: string[] = [];
      const logger = { warn: vi.fn() };
      let now = 0;
      vi.spyOn(Date, "now").mockImplementation(() => now);
      const lockError = Object.assign(new Error("database is locked"), {
        code: "ERR_SQLITE_ERROR",
        errcode: 5,
      });
      const db = {
        location: () => "/synthetic/agent.sqlite",
        exec(sql: string) {
          execCalls.push(sql);
          if (sql === "BEGIN IMMEDIATE") {
            now += 7;
            throw lockError;
          }
        },
      } as import("node:sqlite").DatabaseSync;

      let thrown: unknown;
      try {
        const run = () =>
          runSqliteImmediateTransactionSync(db, () => "blocked", {
            busyTimeoutMs: 5_000,
            logger,
            ...(labels === "explicit"
              ? { databaseLabel: "agent.sqlite", operationLabel: "session.patch" }
              : {}),
          });
        if (labels === "unlabeled") {
          run();
        } else {
          withSqliteReaderOwner({ operation: "worker.patch", ownerKind: "worker" }, run);
        }
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBe(lockError);
      expect(execCalls).toEqual(["BEGIN IMMEDIATE"]);
      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect(logger.warn).toHaveBeenCalledWith(
        "SQLite transaction lock wait failed",
        expect.objectContaining({
          async: false,
          busyTimeoutMs: 5_000,
          code: "ERR_SQLITE_ERROR",
          database: labels === "explicit" ? "agent.sqlite" : "/synthetic/agent.sqlite",
          elapsedMs: 7,
          beginAdmission: { nativeAttempts: 1, nativeMs: 7, serviceCalls: 0, serviceMs: 0 },
          failureKind: "lock-contention",
          isMainThread,
          operation:
            labels === "explicit"
              ? "session.patch"
              : labels === "inherited"
                ? "worker.patch"
                : "unlabeled",
          pid: process.pid,
          sqliteErrcode: 5,
          sqlitePrimaryCode: 5,
          step: "begin",
          threadId,
        }),
      );
    },
  );

  it("does not warn for busyTimeoutMs: 0 with fast successful transactions (regression)", () => {
    const logger = { warn: vi.fn() };
    let now = 0;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const db = createDatabase();
    const location = vi.spyOn(db, "location");
    const exec = db.exec.bind(db);
    vi.spyOn(db, "exec").mockImplementation((sql) => {
      exec(sql);
      now += 5;
    });

    runSqliteImmediateTransactionSync(
      db,
      () => {
        now += 5;
        return "committed";
      },
      { busyTimeoutMs: 0, logger },
    );

    // busyTimeoutMs: 0 should NOT collapse threshold to 1ms.
    // With the default 1000ms threshold, 5ms steps are not slow.
    // Before the fix, this would have produced false-positive warnings.
    expect(logger.warn).not.toHaveBeenCalledWith("slow SQLite transaction step", expect.anything());
    expect(location).not.toHaveBeenCalled();
  });

  it("still warns for busyTimeoutMs: 0 when transaction crosses the default 1000ms threshold", () => {
    const logger = { warn: vi.fn() };
    let now = 0;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const db = createDatabase();
    const exec = db.exec.bind(db);
    vi.spyOn(db, "exec").mockImplementation((sql) => {
      exec(sql);
      now += 1_500;
    });

    runSqliteImmediateTransactionSync(db, () => "committed", {
      busyTimeoutMs: 0,
      databaseLabel: "agent.sqlite",
      logger,
      slowTransactionHoldMs: 0,
    });

    // The 1000ms default threshold still catches genuinely slow transactions.
    expect(logger.warn).toHaveBeenCalledWith("slow SQLite transaction step", expect.anything());
  });

  it.each(["immediate", "deferred"] as const)(
    "logs slow successful %s transaction steps without attributing lock contention",
    (mode) => {
      const logger = { warn: vi.fn() };
      let now = 0;
      vi.spyOn(Date, "now").mockImplementation(() => now);
      const db = createDatabase();
      const exec = db.exec.bind(db);
      vi.spyOn(db, "exec").mockImplementation((sql) => {
        exec(sql);
        now += 1_500;
      });

      const run =
        mode === "immediate" ? runSqliteImmediateTransactionSync : runSqliteDeferredTransactionSync;
      withSqliteReaderOwner({ operation: "worker.entries", ownerKind: "worker" }, () =>
        run(
          db,
          () => {
            db.prepare("INSERT INTO entries VALUES ('committed', 'value')").run();
            now += 1_500;
            return "committed";
          },
          { busyTimeoutMs: 5_000, logger, slowTransactionHoldMs: 0 },
        ),
      );
      expect(readEntries(db)).toEqual(["committed"]);

      expect(logger.warn).toHaveBeenCalledWith(
        "slow SQLite transaction step",
        expect.objectContaining({
          async: false,
          database: ":memory:",
          elapsedMs: 1_500,
          ...(mode === "immediate"
            ? {
                beginAdmission: {
                  nativeAttempts: 1,
                  nativeMs: 1_500,
                  serviceCalls: 0,
                  serviceMs: 0,
                },
              }
            : {}),
          isMainThread,
          operation: "worker.entries",
          pid: process.pid,
          step: "begin",
          threadId,
        }),
      );
      expect(logger.warn).toHaveBeenCalledWith("slow SQLite transaction step", {
        async: false,
        busyTimeoutMs: 5_000,
        database: ":memory:",
        elapsedMs: 1_500,
        isMainThread,
        operation: "worker.entries",
        pid: process.pid,
        step: "commit",
        threadId,
      });
      expect(logger.warn).toHaveBeenCalledWith(
        "slow SQLite transaction hold",
        expect.objectContaining({
          async: false,
          database: ":memory:",
          elapsedMs: 3_000,
          isMainThread,
          mode,
          operation: "worker.entries",
          pid: process.pid,
          threadId,
        }),
      );
    },
  );

  it.each([false, true])(
    "names a slow failed transaction holder (rollback fails: %s)",
    (rollbackFails) => {
      const logger = { warn: vi.fn() };
      let now = 0;
      vi.spyOn(Date, "now").mockImplementation(() => now);
      const db = createDatabase();
      if (rollbackFails) {
        const exec = db.exec.bind(db);
        vi.spyOn(db, "exec").mockImplementation((sql) => {
          if (sql === "ROLLBACK") {
            throw new Error("rollback failed");
          }
          exec(sql);
        });
      }
      expect(() =>
        runSqliteImmediateTransactionSync(
          db,
          () => {
            now += 5_100;
            throw new Error("rejected mutation");
          },
          {
            ...(rollbackFails ? {} : { databaseLabel: "agent.sqlite" }),
            operationLabel: "session.write",
            logger,
          },
        ),
      ).toThrow("rejected mutation");
      expect(db.isOpen).toBe(!rollbackFails);
      if (!rollbackFails) {
        expect(db.isTransaction).toBe(false);
      }
      expect(logger.warn).toHaveBeenCalledWith(
        "slow SQLite transaction hold",
        expect.objectContaining({
          database: rollbackFails ? "unavailable" : "agent.sqlite",
          elapsedMs: 5_100,
          isMainThread,
          mode: "immediate",
          operation: "session.write",
        }),
      );
    },
  );
});

it("attributes a generic coordinator wait to its owning caller without tracing fast admission", () => {
  setLoggerOverride({ level: "silent", consoleLevel: "warn", consoleStyle: "json" });
  const warn = vi.fn();
  loggingState.rawConsole = { log: vi.fn(), info: vi.fn(), warn, error: vi.fn() };
  const capture = vi.spyOn(Error, "captureStackTrace");
  const options = { databaseLabel: "synthetic.sqlite", operationLabel: "state.write" };
  logSlowSqliteCoordinatorWait(100, options);
  expect(capture).not.toHaveBeenCalled();
  expect(warn).not.toHaveBeenCalled();

  function finalizeSyntheticRun() {
    logSlowSqliteCoordinatorWait(600, options);
  }
  finalizeSyntheticRun();
  expect(warn).toHaveBeenCalledOnce();
  expect(JSON.parse(String(warn.mock.calls[0]?.[0]))).toMatchObject({
    message: "slow SQLite coordinator lock wait",
    caller: expect.stringContaining("finalizeSyntheticRun"),
    database: "synthetic.sqlite",
    elapsedMs: 600,
    operation: "state.write",
    async: false,
  });
});

it("preserves coordinator admission when diagnostic stack capture fails", () => {
  vi.spyOn(Error, "captureStackTrace").mockImplementation(() => {
    throw new Error("Synthetic diagnostics failure");
  });
  expect(() =>
    logSlowSqliteCoordinatorWait(600, { operationLabel: "task.mutation" }),
  ).not.toThrow();
});
