import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import { runSqliteImmediateTransaction } from "./sqlite-transaction.js";

const databases: DatabaseSync[] = [];
const directories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const db of databases.splice(0)) {
    if (db.isOpen) {
      db.close();
    }
  }
  for (const directory of directories.splice(0)) {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "sqlite-inherited-deadline-"));
  directories.push(directory);
  const db = new DatabaseSync(path.join(directory, "index.sqlite"));
  const blocker = new DatabaseSync(path.join(directory, "index.sqlite"));
  databases.push(db, blocker);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE entries(value TEXT)");
  return { db, blocker };
}

describe("inherited SQLite BEGIN deadline", () => {
  it("keeps the first nonblocking attempt after queue/startup consumed the budget", async () => {
    const { db } = await fixture();
    const beginDeadlineNs = process.hrtime.bigint() - 1n;
    await runSqliteImmediateTransaction(
      db,
      async () => () => {
        expect(db.prepare("PRAGMA busy_timeout").get()?.timeout).toBe(5000);
        db.prepare("INSERT INTO entries VALUES (?)").run("committed");
      },
      { beginDeadlineNs },
    );
    expect(db.prepare("SELECT value FROM entries").all()).toEqual([{ value: "committed" }]);
    expect(db.prepare("PRAGMA busy_timeout").get()?.timeout).toBe(5000);
  });

  it("returns the original first lock error without a fresh Worker retry budget", async () => {
    const { db, blocker } = await fixture();
    blocker.exec("BEGIN IMMEDIATE");
    const exec = db.exec.bind(db);
    let firstFailure: unknown;
    let attempts = 0;
    vi.spyOn(db, "exec").mockImplementation((sql) => {
      if (sql === "BEGIN IMMEDIATE") {
        attempts += 1;
      }
      try {
        return exec(sql);
      } catch (error) {
        firstFailure ??= error;
        throw error;
      }
    });
    const prepare = vi.fn(async () => () => db.exec("INSERT INTO entries VALUES ('unexpected')"));
    const result = await runSqliteImmediateTransaction(db, prepare, {
      beginDeadlineNs: process.hrtime.bigint() - 1n,
    }).catch((error: unknown) => error);
    expect(result).toBe(firstFailure);
    expect(result).toMatchObject({ errcode: 5 });
    expect(attempts).toBe(1);
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(db.prepare("PRAGMA busy_timeout").get()?.timeout).toBe(5000);
    blocker.exec("ROLLBACK");
    expect(db.prepare("SELECT value FROM entries").all()).toEqual([]);
  });

  it.each(["prepare", "admit"] as const)(
    "retains an eligible second attempt delayed in %s",
    async (phase) => {
      const { db, blocker } = await fixture();
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
    },
  );
});
