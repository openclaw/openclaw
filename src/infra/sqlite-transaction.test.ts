// Covers synchronous SQLite transaction helpers.
import { afterEach, describe, expect, it, vi } from "vitest";
import { requireNodeSqlite } from "./node-sqlite.js";
import {
  runSqliteImmediateTransactionAsync,
  runSqliteImmediateTransactionSync,
} from "./sqlite-transaction.js";

const openDatabases: Array<import("node:sqlite").DatabaseSync> = [];

function createDatabase(): import("node:sqlite").DatabaseSync {
  const { DatabaseSync } = requireNodeSqlite();
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE entries (id TEXT NOT NULL PRIMARY KEY, value TEXT NOT NULL);");
  openDatabases.push(db);
  return db;
}

function readEntries(db: import("node:sqlite").DatabaseSync): string[] {
  return db
    .prepare("SELECT id FROM entries ORDER BY id")
    .all()
    .map((row) => (row as { id: string }).id);
}

afterEach(() => {
  for (const db of openDatabases.splice(0)) {
    db.close();
  }
  vi.restoreAllMocks();
});

describe("runSqliteImmediateTransactionSync", () => {
  it("keeps outer writes when a nested savepoint rolls back", () => {
    const db = createDatabase();

    runSqliteImmediateTransactionSync(db, () => {
      db.prepare("INSERT INTO entries(id, value) VALUES (?, ?)").run("outer", "kept");
      expect(() =>
        runSqliteImmediateTransactionSync(db, () => {
          db.prepare("INSERT INTO entries(id, value) VALUES (?, ?)").run("inner", "rolled back");
          throw new Error("nested failure");
        }),
      ).toThrow("nested failure");
    });

    expect(readEntries(db)).toEqual(["outer"]);
  });

  it("commits nested savepoint writes with the outer transaction", () => {
    const db = createDatabase();

    runSqliteImmediateTransactionSync(db, () => {
      db.prepare("INSERT INTO entries(id, value) VALUES (?, ?)").run("outer", "kept");
      runSqliteImmediateTransactionSync(db, () => {
        db.prepare("INSERT INTO entries(id, value) VALUES (?, ?)").run("inner", "kept");
      });
    });

    expect(readEntries(db)).toEqual(["inner", "outer"]);
  });

  it("rejects Promise-returning operations and rolls back their synchronous writes", () => {
    const db = createDatabase();

    expect(() =>
      runSqliteImmediateTransactionSync(db, async () => {
        db.prepare("INSERT INTO entries(id, value) VALUES (?, ?)").run("async", "rolled back");
        return "done";
      }),
    ).toThrow("must be synchronous");
    expect(readEntries(db)).toEqual([]);

    runSqliteImmediateTransactionSync(db, () => {
      db.prepare("INSERT INTO entries(id, value) VALUES (?, ?)").run("after", "works");
    });
    expect(readEntries(db)).toEqual(["after"]);
  });

  it("retries retryable commit failures without rolling back successful writes", () => {
    const execCalls: string[] = [];
    let commitAttempts = 0;
    const db = {
      exec(sql: string) {
        execCalls.push(sql);
        if (sql === "COMMIT") {
          commitAttempts += 1;
          if (commitAttempts === 1) {
            throw Object.assign(new Error("database is busy"), { code: "SQLITE_BUSY" });
          }
        }
      },
    } as import("node:sqlite").DatabaseSync;

    const result = runSqliteImmediateTransactionSync(db, () => "committed");

    expect(result).toBe("committed");
    expect(execCalls).toEqual(["BEGIN IMMEDIATE", "COMMIT", "COMMIT"]);
  });

  it("rolls back and clears depth after exhausted retryable commit failures", () => {
    const execCalls: string[] = [];
    let failCommits = true;
    const db = {
      exec(sql: string) {
        execCalls.push(sql);
        if (failCommits && sql === "COMMIT") {
          throw Object.assign(new Error("database is busy"), { code: "SQLITE_BUSY" });
        }
      },
      close() {},
    } as import("node:sqlite").DatabaseSync;

    expect(() => runSqliteImmediateTransactionSync(db, () => "not committed")).toThrow(
      "database is busy",
    );

    expect(execCalls.filter((sql) => sql === "COMMIT")).toHaveLength(8);
    expect(execCalls.at(-1)).toBe("ROLLBACK");

    execCalls.length = 0;
    failCommits = false;
    const result = runSqliteImmediateTransactionSync(db, () => "committed later");

    expect(result).toBe("committed later");
    expect(execCalls).toEqual(["BEGIN IMMEDIATE", "COMMIT"]);
  });

  it("wraps begin busy timeouts with actionable wait context", () => {
    const logger = { warn: vi.fn() };
    const db = {
      exec(sql: string) {
        if (sql === "BEGIN IMMEDIATE") {
          throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
        }
      },
    } as import("node:sqlite").DatabaseSync;

    expect(() =>
      runSqliteImmediateTransactionSync(db, () => "blocked", {
        busyTimeoutMs: 5_000,
        databaseLabel: "agent.sqlite",
        logger,
      }),
    ).toThrow(/begin for agent\.sqlite timed out.*busy_timeout=5000ms.*database is locked/);
    expect(logger.warn).toHaveBeenCalledWith(
      "SQLite transaction lock wait failed",
      expect.objectContaining({
        busyTimeoutMs: 5_000,
        code: "SQLITE_BUSY",
        database: "agent.sqlite",
        step: "begin",
      }),
    );
  });

  it("retries begin waits until the cumulative transaction cap", () => {
    const execCalls: string[] = [];
    const logger = { warn: vi.fn() };
    let now = 0;
    vi.spyOn(Date, "now").mockImplementation(() => {
      const value = now;
      now += 2_000;
      return value;
    });
    const db = {
      exec(sql: string) {
        execCalls.push(sql);
        if (sql === "BEGIN IMMEDIATE") {
          throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
        }
      },
    } as import("node:sqlite").DatabaseSync;

    expect(() =>
      runSqliteImmediateTransactionSync(db, () => "blocked", {
        busyTimeoutMs: 5_000,
        databaseLabel: "agent.sqlite",
        logger,
        maxBusyWaitMs: 3_000,
      }),
    ).toThrow(/begin for agent\.sqlite timed out after waiting 4000ms across 2 attempt/);

    expect(execCalls).toEqual(["BEGIN IMMEDIATE", "BEGIN IMMEDIATE"]);
  });

  it("logs slow successful transaction lock waits", () => {
    const logger = { warn: vi.fn() };
    let now = 0;
    vi.spyOn(Date, "now").mockImplementation(() => {
      const value = now;
      now += 1_500;
      return value;
    });
    const db = {
      exec() {},
    } as import("node:sqlite").DatabaseSync;

    runSqliteImmediateTransactionSync(db, () => "committed", {
      busyTimeoutMs: 5_000,
      databaseLabel: "agent.sqlite",
      logger,
    });

    expect(logger.warn).toHaveBeenCalledWith(
      "slow SQLite transaction lock wait",
      expect.objectContaining({
        database: "agent.sqlite",
        elapsedMs: 1_500,
        step: "begin",
      }),
    );
    expect(logger.warn).toHaveBeenCalledWith(
      "slow SQLite transaction lock wait",
      expect.objectContaining({
        database: "agent.sqlite",
        elapsedMs: 1_500,
        step: "commit",
      }),
    );
  });

  it("stops retrying commits when cumulative busy wait reaches the transaction cap", () => {
    const execCalls: string[] = [];
    const logger = { warn: vi.fn() };
    let now = 0;
    vi.spyOn(Date, "now").mockImplementation(() => {
      const value = now;
      now += 2_000;
      return value;
    });
    const db = {
      exec(sql: string) {
        execCalls.push(sql);
        if (sql === "COMMIT") {
          throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
        }
      },
      close() {},
    } as import("node:sqlite").DatabaseSync;

    expect(() =>
      runSqliteImmediateTransactionSync(db, () => "blocked", {
        busyTimeoutMs: 5_000,
        databaseLabel: "agent.sqlite",
        logger,
        maxBusyWaitMs: 3_000,
      }),
    ).toThrow(/commit for agent\.sqlite timed out after waiting 4000ms across 2 attempt/);

    expect(execCalls.filter((sql) => sql === "COMMIT")).toHaveLength(2);
    expect(execCalls.at(-1)).toBe("ROLLBACK");
  });
});

describe("runSqliteImmediateTransactionAsync", () => {
  it("keeps outer async writes when a nested savepoint rolls back", async () => {
    const db = createDatabase();

    await runSqliteImmediateTransactionAsync(db, async () => {
      db.prepare("INSERT INTO entries(id, value) VALUES (?, ?)").run("outer", "kept");
      await expect(
        runSqliteImmediateTransactionAsync(db, async () => {
          db.prepare("INSERT INTO entries(id, value) VALUES (?, ?)").run("inner", "rolled back");
          throw new Error("nested failure");
        }),
      ).rejects.toThrow("nested failure");
    });

    expect(readEntries(db)).toEqual(["outer"]);
  });

  it("retries retryable async commit failures", async () => {
    const execCalls: string[] = [];
    let commitAttempts = 0;
    const db = {
      exec(sql: string) {
        execCalls.push(sql);
        if (sql === "COMMIT") {
          commitAttempts += 1;
          if (commitAttempts === 1) {
            throw Object.assign(new Error("database is busy"), { code: "SQLITE_BUSY" });
          }
        }
      },
    } as import("node:sqlite").DatabaseSync;

    const result = await runSqliteImmediateTransactionAsync(db, async () => "committed");

    expect(result).toBe("committed");
    expect(execCalls).toEqual(["BEGIN IMMEDIATE", "COMMIT", "COMMIT"]);
  });

  it("does not treat unrelated same-handle writes as nested savepoints", async () => {
    const db = createDatabase();
    let releaseOuter: (() => void) | undefined;
    const outerReady = new Promise<void>((resolve) => {
      releaseOuter = resolve;
    });
    let outerEntered: (() => void) | undefined;
    const outerStarted = new Promise<void>((resolve) => {
      outerEntered = resolve;
    });
    const outer = runSqliteImmediateTransactionAsync(db, async () => {
      db.prepare("INSERT INTO entries(id, value) VALUES (?, ?)").run("outer", "rolled back");
      outerEntered?.();
      await outerReady;
      throw new Error("outer failure");
    });

    await outerStarted;
    expect(() =>
      runSqliteImmediateTransactionSync(db, () => {
        db.prepare("INSERT INTO entries(id, value) VALUES (?, ?)").run("unrelated", "blocked");
      }),
    ).toThrow();
    releaseOuter?.();
    await expect(outer).rejects.toThrow("outer failure");
    await expect(
      runSqliteImmediateTransactionAsync(db, async () => {
        db.prepare("INSERT INTO entries(id, value) VALUES (?, ?)").run("after", "works");
      }),
    ).resolves.toBeUndefined();

    expect(readEntries(db)).toEqual(["after"]);
  });
});
