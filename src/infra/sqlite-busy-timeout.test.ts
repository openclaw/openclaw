import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import {
  readSqliteBusyTimeout as readTimeout,
  runWithSqliteBusyTimeout as withTimeout,
  setSqliteBusyTimeout as writeTimeout,
  shouldReportSqliteLockFailure as reportsLocks,
} from "./sqlite-busy-timeout.js";
import { runSqliteImmediateTransactionSync } from "./sqlite-transaction.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => vi.restoreAllMocks());
const timeoutOf = (db: DatabaseSync) => db.prepare("PRAGMA busy_timeout").get();
const suppress = { lockFailureReporting: "suppress" } as const;

it.each([
  [undefined, 5000, 0],
  [-1, 0, 25],
  [0, 0, 25],
  [37, 37, 25],
] as const)("restores constructor policy %s", (timeout, initial, temporary) => {
  using db = openNodeSqliteDatabase(":memory:", timeout === undefined ? undefined : { timeout });
  if (timeout === undefined) {
    db.exec("PRAGMA busy_timeout = 5000");
  } else {
    expect(readTimeout(db)).toBe(initial);
    writeTimeout(db, initial);
  }
  expect(withTimeout(db, temporary, () => timeoutOf(db))).toEqual({ timeout: temporary });
  expect(timeoutOf(db)).toEqual({ timeout: initial });
  expect(() =>
    withTimeout(db, 25, () => {
      throw new Error("operation failed");
    }),
  ).toThrow("operation failed");
  expect(timeoutOf(db)).toEqual({ timeout: initial });
});

it("restores timeout and lock reporting before the admitted operation finishes", () => {
  using db = new DatabaseSync(":memory:");
  db.exec("PRAGMA busy_timeout = 5000");
  const restoreEarly = (restore: () => void) => {
    expect(reportsLocks(db)).toBe(false);
    restore();
    expect([timeoutOf(db), reportsLocks(db)]).toEqual([{ timeout: 5000 }, true]);
  };
  withTimeout(db, 25, restoreEarly, suppress);
  expect([timeoutOf(db), reportsLocks(db)]).toEqual([{ timeout: 5000 }, true]);
});

it.each([undefined, { timeout: 19 }, { timeout: 37, open: false }])(
  "discards changed policy across close/reopen with constructor options %j",
  (options) => {
    using db = options ? openNodeSqliteDatabase(":memory:", options) : new DatabaseSync(":memory:");
    if (!db.isOpen) {
      db.open();
    }
    const timeout = options?.timeout ?? 0;
    expect(readTimeout(db)).toBe(timeout);
    writeTimeout(db, 73);
    db.close();
    db.open();
    expect(readTimeout(db)).toBe(timeout);
    withTimeout(db, 25, () => undefined);
    expect(timeoutOf(db)).toEqual({ timeout });
  },
);

it("rejects an invalid timeout", () => {
  using db = new DatabaseSync(":memory:");
  expect(() => withTimeout(db, -1, () => undefined)).toThrow(
    "busyTimeoutMs must be a non-negative integer",
  );
});

it("suppresses expected lock warnings only for the scoped attempt", () => {
  const databasePath = path.join(tempDirs.make("sqlite-busy-timeout-"), "state.sqlite");
  using db = new DatabaseSync(databasePath);
  using contender = new DatabaseSync(databasePath);
  const logger = { warn: vi.fn() };
  db.exec("PRAGMA journal_mode = WAL; CREATE TABLE entries (id TEXT PRIMARY KEY)");
  contender.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE");

  const attempt = () =>
    runSqliteImmediateTransactionSync(db, () => undefined, { busyTimeoutMs: 0, logger });
  expect(() => withTimeout(db, 0, attempt, suppress)).toThrow();
  expect(logger.warn).not.toHaveBeenCalled();
});
