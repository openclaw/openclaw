import { expect, it, vi } from "vitest";
import {
  sqliteMaintenanceFixture,
  sqliteWriteGate,
} from "./sqlite-maintenance-fixture.test-support.js";
import { runSqliteImmediateTransaction } from "./sqlite-transaction.js";

const resources = sqliteMaintenanceFixture();

function fixture() {
  const file = resources.file();
  const db = resources.open(file);
  const blocker = resources.open(file);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE entries(value TEXT)");
  return { db, blocker };
}

it.each([false, true])("attempts expired BEGIN once (locked: %s)", async (locked) => {
  const { db, blocker } = fixture();
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
  const { db, blocker } = fixture();
  blocker.exec("BEGIN IMMEDIATE");
  const beginDeadlineNs = 1_000_000_000n;
  let now = 0n;
  vi.spyOn(process.hrtime, "bigint").mockImplementation(() => now);
  const gate = sqliteWriteGate();
  const calls = { prepare: 0, admit: 0 };
  const pending = runSqliteImmediateTransaction(
    db,
    async () => {
      calls.prepare += 1;
      if (phase === "prepare" && calls.prepare === 2) {
        await gate.wait();
      }
      return () => {
        expect(db.prepare("PRAGMA busy_timeout").get()?.timeout).toBe(5000);
        db.exec("INSERT INTO entries VALUES ('eligible')");
      };
    },
    { beginDeadlineNs },
    async (write) => {
      calls.admit += 1;
      if (phase === "admit" && calls.admit === 2) {
        await gate.wait();
      }
      return write();
    },
  );
  void pending.catch(() => undefined);
  try {
    await Promise.race([gate.entered, pending]);
    expect(calls.prepare).toBe(2);
    now = beginDeadlineNs + 1n;
    blocker.exec("COMMIT");
    gate.release();
    await pending;
    expect(calls.admit).toBe(2);
    expect(db.prepare("SELECT value FROM entries").all()).toEqual([{ value: "eligible" }]);
    expect(db.prepare("PRAGMA busy_timeout").get()?.timeout).toBe(5000);
  } finally {
    gate.release();
    if (blocker.isTransaction) {
      blocker.exec("ROLLBACK");
    }
    await pending.catch(() => undefined);
  }
});
