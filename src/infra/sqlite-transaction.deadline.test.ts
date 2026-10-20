import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createDeferredCore } from "../shared/deferred.js";
import { runSqliteImmediateTransaction } from "./sqlite-transaction.js";

const directories = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

function fixture() {
  const directory = directories.make("sqlite-inherited-deadline-");
  const db = new DatabaseSync(path.join(directory, "index.sqlite"));
  const blocker = new DatabaseSync(path.join(directory, "index.sqlite"));
  db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE entries(value TEXT)");
  return {
    db,
    blocker,
    [Symbol.dispose]() {
      db.close();
      blocker.close();
    },
  };
}

it.each([false, true])("attempts expired BEGIN once (locked: %s)", async (locked) => {
  using state = fixture();
  const { db, blocker } = state;
  if (locked) {
    blocker.exec("BEGIN IMMEDIATE");
  }
  const exec = db.exec.bind(db);
  let firstFailure: unknown;
  const attempts = vi.spyOn(db, "exec").mockImplementation((sql) => {
    try {
      return exec(sql);
    } catch (error) {
      firstFailure ??= error;
      throw error;
    }
  });
  const queries = vi.spyOn(db, "prepare");
  const prepare = vi.fn(async () => () => {
    expect(queries.mock.calls.filter(([sql]) => sql === "PRAGMA busy_timeout")).toHaveLength(1);
    expect(db.prepare("PRAGMA busy_timeout").get()?.timeout).toBe(5000);
    db.prepare("INSERT INTO entries VALUES (?)").run("committed");
  });
  const result = await runSqliteImmediateTransaction(db, prepare, {
    beginDeadlineNs: process.hrtime.bigint() - 1n,
  }).catch((error: unknown) => error);
  if (locked) {
    expect(result).toBe(firstFailure);
    expect(result).toMatchObject({ errcode: 5 });
    blocker.exec("ROLLBACK");
  } else {
    expect(result).toBeUndefined();
  }
  expect(attempts.mock.calls.filter(([sql]) => sql === "BEGIN IMMEDIATE")).toHaveLength(1);
  expect(prepare).toHaveBeenCalledTimes(1);
  expect(db.prepare("PRAGMA busy_timeout").get()?.timeout).toBe(5000);
  expect(db.prepare("SELECT value FROM entries").all()).toEqual(
    locked ? [] : [{ value: "committed" }],
  );
});

it.each(["prepare", "admit"] as const)("retains an eligible BEGIN delayed in %s", async (phase) => {
  using state = fixture();
  const { db, blocker } = state;
  blocker.exec("BEGIN IMMEDIATE");
  const beginDeadlineNs = 1_000_000_000n;
  let now = 0n;
  vi.spyOn(process.hrtime, "bigint").mockImplementation(() => now);
  const delayed = createDeferredCore();
  const resume = createDeferredCore();
  let preparations = 0;
  let admissions = 0;
  const wait = async () => {
    delayed.resolve();
    await resume.promise;
  };
  const pending = runSqliteImmediateTransaction(
    db,
    async () => {
      preparations += 1;
      if (phase === "prepare" && preparations === 2) {
        await wait();
      }
      return () => {
        expect(db.prepare("PRAGMA busy_timeout").get()?.timeout).toBe(5000);
        db.exec("INSERT INTO entries VALUES ('eligible')");
      };
    },
    { beginDeadlineNs },
    async (write) => {
      admissions += 1;
      if (phase === "admit" && admissions === 2) {
        await wait();
      }
      return write();
    },
  );
  void pending.catch(() => undefined);
  try {
    await Promise.race([delayed.promise, pending]);
    expect(preparations).toBe(2);
    now = beginDeadlineNs + 1n;
    blocker.exec("COMMIT");
    resume.resolve();
    await pending;
    expect(admissions).toBe(2);
    expect(db.prepare("SELECT value FROM entries").all()).toEqual([{ value: "eligible" }]);
    expect(db.prepare("PRAGMA busy_timeout").get()?.timeout).toBe(5000);
  } finally {
    resume.resolve();
    if (blocker.isTransaction) {
      blocker.exec("ROLLBACK");
    }
    await pending.catch(() => undefined);
  }
});
