import { DatabaseSync } from "node:sqlite";
import { isMainThread, threadId } from "node:worker_threads";
import { afterEach, expect, it, vi } from "vitest";
import { runSqliteTransactionSync } from "./sqlite-transaction-core.js";
import { runSqliteImmediateTransactionSync } from "./sqlite-transaction.js";

const defaultLogger = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock("../logging/subsystem.js", () => ({ createSubsystemLogger: () => defaultLogger }));

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
    let stepMs = 999;
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
      expect(selected.warn).toHaveBeenNthCalledWith(1, "slow SQLite transaction lock wait", {
        ...common,
        step: "begin",
        beginAdmission: { nativeAttempts: 1, nativeMs: 1_000, serviceCalls: 0, serviceMs: 0 },
      });
      expect(selected.warn).toHaveBeenNthCalledWith(2, "slow SQLite transaction hold", {
        ...common,
        thresholdMs: 1_000,
      });
      expect(selected.warn).toHaveBeenNthCalledWith(3, "slow SQLite transaction lock wait", {
        ...common,
        step: "commit",
      });
      expect((logger ? defaultLogger : customLogger).warn).not.toHaveBeenCalled();
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
