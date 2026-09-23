import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { isMainThread, threadId } from "node:worker_threads";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { runSqliteTransactionSync } from "./sqlite-transaction-core.js";
import {
  logSlowSqliteCoordinatorWait,
  runSqliteImmediateTransactionSync,
} from "./sqlite-transaction.js";

const defaultLogger = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock("../logging/subsystem.js", () => ({ createSubsystemLogger: () => defaultLogger }));
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

it.each(["default", "custom"])(
  "preserves the %s reporter and diagnostic thresholds",
  (reporter) => {
    const db = new DatabaseSync(":memory:");
    const customLogger = { warn: vi.fn() };
    const logger = reporter === "custom" ? customLogger : undefined;
    const selected = logger ?? defaultLogger;
    let now = 0;
    let stepMs = 499;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const exec = db.exec.bind(db);
    vi.spyOn(db, "exec").mockImplementation((sql) => {
      exec(sql);
      now += stepMs;
    });
    const write = () => {
      now += stepMs;
      return "committed";
    };
    try {
      const options = { logger, databaseLabel: "reporting", operationLabel: "write" };
      expect(runSqliteImmediateTransactionSync(db, write, options)).toBe("committed");
      expect(selected.warn).not.toHaveBeenCalled();
      stepMs = 1_000;
      expect(runSqliteImmediateTransactionSync(db, write, options)).toBe("committed");
      expect(selected.warn).toHaveBeenCalledTimes(3);
      const common = {
        async: false,
        database: "reporting",
        elapsedMs: 1_000,
        isMainThread,
        operation: "write",
        pid: process.pid,
        threadId,
      };
      expect(selected.warn).toHaveBeenNthCalledWith(1, "slow SQLite transaction step", {
        ...common,
        step: "begin",
        beginAdmission: { nativeAttempts: 1, nativeMs: 1_000, serviceCalls: 0, serviceMs: 0 },
      });
      expect(selected.warn).toHaveBeenNthCalledWith(2, "slow SQLite transaction step", {
        ...common,
        step: "commit",
      });
      expect(selected.warn).toHaveBeenNthCalledWith(3, "slow SQLite transaction hold", {
        ...common,
        elapsedMs: 2_000,
        mode: "immediate",
        thresholdMs: 1_000,
      });
      expect((logger ? defaultLogger : customLogger).warn).not.toHaveBeenCalled();
    } finally {
      db.close();
    }
  },
);

it.each([false, true])(
  "preserves the settled transaction when its hold reporter throws (rollback: %s)",
  (rollback) => {
    const db = new DatabaseSync(":memory:");
    const failure = new Error("original transaction failure");
    let now = 0;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const heldAtReport: boolean[] = [];
    const warn = vi.fn(() => {
      heldAtReport.push(db.isTransaction);
      throw new Error("hold reporter failure");
    });
    try {
      db.exec("CREATE TABLE entries (value TEXT NOT NULL)");
      const operation = () =>
        runSqliteImmediateTransactionSync(
          db,
          () => {
            db.prepare("INSERT INTO entries VALUES ('committed')").run();
            now += 1_000;
            if (rollback) {
              throw failure;
            }
            return "committed";
          },
          { logger: { warn } },
        );
      if (rollback) {
        let caught: unknown;
        try {
          operation();
        } catch (error) {
          caught = error;
        }
        expect(caught).toBe(failure);
      } else {
        expect(operation()).toBe("committed");
      }
      expect(db.isTransaction).toBe(false);
      expect(db.prepare("SELECT value FROM entries").all()).toEqual(
        rollback ? [] : [{ value: "committed" }],
      );
      expect(warn).toHaveBeenCalledOnce();
      expect(warn).toHaveBeenCalledWith(
        "slow SQLite transaction hold",
        expect.objectContaining({ elapsedMs: 1_000 }),
      );
      expect(heldAtReport).toEqual([false]);
      expect(defaultLogger.warn).not.toHaveBeenCalled();
    } finally {
      db.close();
    }
  },
);

it("keeps an explicit no-op reporter independent of default reporting", () => {
  const db = new DatabaseSync(":memory:");
  let now = 0;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  try {
    runSqliteTransactionSync(
      db,
      () => {
        now += 1_000;
      },
      "immediate",
      { logger: { warn() {} } },
    );
    expect(db.isTransaction).toBe(false);
    expect(defaultLogger.warn).not.toHaveBeenCalled();
  } finally {
    db.close();
  }
});

it.each(["BEGIN IMMEDIATE", "COMMIT"])(
  "preserves the committed result when the %s reporter throws",
  (slowStep) => {
    const db = new DatabaseSync(":memory:");
    let now = 0;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const exec = db.exec.bind(db);
    const statements: string[] = [];
    vi.spyOn(db, "exec").mockImplementation((sql) => {
      exec(sql);
      statements.push(sql);
      if (sql === slowStep) {
        now += 1_000;
      }
    });
    const warn = vi.fn(() => {
      throw new Error("step reporter failure");
    });
    const write = vi.fn(() => {
      db.prepare("INSERT INTO entries VALUES ('committed')").run();
      return "committed";
    });
    try {
      db.exec("CREATE TABLE entries (value TEXT NOT NULL)");
      expect(runSqliteImmediateTransactionSync(db, write, { logger: { warn } })).toBe("committed");
      expect(write).toHaveBeenCalledOnce();
      expect(db.isTransaction).toBe(false);
      expect(db.prepare("SELECT value FROM entries").all()).toEqual([{ value: "committed" }]);
      expect(statements).toEqual([
        "CREATE TABLE entries (value TEXT NOT NULL)",
        "BEGIN IMMEDIATE",
        "COMMIT",
      ]);
      expect(warn).toHaveBeenCalledWith(
        "slow SQLite transaction step",
        expect.objectContaining({ step: slowStep === "COMMIT" ? "commit" : "begin" }),
      );
    } finally {
      if (db.isOpen) {
        db.close();
      }
    }
  },
);

it("preserves the native lock error when its reporter throws", () => {
  const databasePath = path.join(tempDirs.make("sqlite-reporting-lock-"), "state.sqlite");
  const db = new DatabaseSync(databasePath);
  const writer = new DatabaseSync(databasePath);
  let nativeError: unknown;
  const write = vi.fn();
  const warn = vi.fn(() => {
    throw new Error("lock reporter failure");
  });
  try {
    db.exec("PRAGMA busy_timeout=0; CREATE TABLE entries (value TEXT NOT NULL)");
    writer.exec("BEGIN IMMEDIATE");
    const exec = db.exec.bind(db);
    vi.spyOn(db, "exec").mockImplementation((sql) => {
      try {
        exec(sql);
      } catch (error) {
        nativeError = error;
        throw error;
      }
    });
    let caught: unknown;
    try {
      runSqliteImmediateTransactionSync(db, write, { logger: { warn } });
    } catch (error) {
      caught = error;
    }
    expect(nativeError).toMatchObject({ errcode: 5 });
    expect(caught).toBe(nativeError);
    expect(write).not.toHaveBeenCalled();
    expect(db.isTransaction).toBe(false);
    expect(writer.isTransaction).toBe(true);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(
      "SQLite transaction lock wait failed",
      expect.objectContaining({ step: "begin", sqlitePrimaryCode: 5 }),
    );
  } finally {
    writer.close();
    db.close();
  }
});

it("preserves commit authority refusal when its hold reporter throws", () => {
  const db = new DatabaseSync(":memory:");
  const refused = new Error("commit authority revoked");
  let now = 0;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const warn = vi.fn(() => {
    throw new Error("hold reporter failure");
  });
  const withCommit = vi.fn(() => {
    throw refused;
  });
  try {
    db.exec("CREATE TABLE entries (value TEXT NOT NULL)");
    let caught: unknown;
    try {
      runSqliteImmediateTransactionSync(
        db,
        () => {
          db.prepare("INSERT INTO entries VALUES ('refused')").run();
          now += 1_000;
        },
        { logger: { warn }, withCommit },
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(refused);
    expect(withCommit).toHaveBeenCalledOnce();
    expect(db.isTransaction).toBe(false);
    expect(db.prepare("SELECT value FROM entries").all()).toEqual([]);
    expect(warn).toHaveBeenCalledWith(
      "slow SQLite transaction hold",
      expect.objectContaining({ elapsedMs: 1_000 }),
    );
  } finally {
    db.close();
  }
});

it("keeps coordinator warning failure outside acquisition custody", () => {
  defaultLogger.warn.mockImplementationOnce(() => {
    throw new Error("coordinator reporter failure");
  });
  expect(() => logSlowSqliteCoordinatorWait(101, { databaseLabel: "state" })).not.toThrow();
  expect(defaultLogger.warn).toHaveBeenCalledWith(
    "slow SQLite coordinator lock wait",
    expect.objectContaining({ elapsedMs: 101, thresholdMs: 100 }),
  );
});
