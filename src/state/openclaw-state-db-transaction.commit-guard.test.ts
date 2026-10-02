import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import {
  runManagedStateTransaction,
  withOpenClawStateCommitGuard,
} from "./openclaw-state-db-transaction.js";

it("rolls back a shared-state write when authority retires in the precommit owner", async () => {
  using database = new DatabaseSync(":memory:");
  database.exec("CREATE TABLE entries (value TEXT NOT NULL)");
  let current = true;
  const withCommit = vi.fn((commit: () => void) => {
    current = false;
    commit();
  });

  await expect(
    withOpenClawStateCommitGuard(
      () => {
        if (!current) {
          throw new Error("initiating authority retired");
        }
      },
      async () => {
        await Promise.resolve();
        runManagedStateTransaction(
          database,
          () => database.prepare("INSERT INTO entries (value) VALUES (?)").run("revoked"),
          { withCommit },
        );
      },
    ),
  ).rejects.toThrow("initiating authority retired");
  expect(withCommit).toHaveBeenCalledOnce();
  expect(database.isTransaction).toBe(false);
  expect(database.prepare("SELECT value FROM entries").all()).toEqual([]);
});

it("commits nested shared-state writes through the current outer owner", async () => {
  using database = new DatabaseSync(":memory:");
  database.exec("CREATE TABLE entries (value TEXT NOT NULL)");
  const assertCurrent = vi.fn();
  const withCommit = vi.fn((commit: () => void) => commit());

  await withOpenClawStateCommitGuard(assertCurrent, async () => {
    await Promise.resolve();
    runManagedStateTransaction(
      database,
      () => {
        runManagedStateTransaction(
          database,
          () => database.prepare("INSERT INTO entries (value) VALUES (?)").run("nested"),
          {},
        );
        database.prepare("INSERT INTO entries (value) VALUES (?)").run("outer");
      },
      { withCommit },
    );
  });

  expect(withCommit).toHaveBeenCalledOnce();
  expect(assertCurrent).toHaveBeenCalledOnce();
  expect(database.prepare("SELECT value FROM entries ORDER BY rowid").all()).toEqual([
    { value: "nested" },
    { value: "outer" },
  ]);
});

it("rolls back a nested shared-state write when outer commit authority retires", async () => {
  using database = new DatabaseSync(":memory:");
  database.exec("CREATE TABLE entries (value TEXT NOT NULL)");
  let current = true;

  await expect(
    withOpenClawStateCommitGuard(
      () => {
        if (!current) {
          throw new Error("initiating authority retired");
        }
      },
      async () => {
        runManagedStateTransaction(
          database,
          () => {
            runManagedStateTransaction(
              database,
              () => database.prepare("INSERT INTO entries (value) VALUES (?)").run("nested"),
              {},
            );
            current = false;
          },
          {},
        );
      },
    ),
  ).rejects.toThrow("initiating authority retired");
  expect(database.isTransaction).toBe(false);
  expect(database.prepare("SELECT value FROM entries").all()).toEqual([]);
});

it("keeps unscoped shared-state transactions unchanged", () => {
  using database = new DatabaseSync(":memory:");
  database.exec("CREATE TABLE entries (value TEXT NOT NULL)");
  const withCommit = vi.fn((commit: () => void) => commit());

  runManagedStateTransaction(
    database,
    () => database.prepare("INSERT INTO entries (value) VALUES (?)").run("cli"),
    { withCommit },
  );

  expect(withCommit).toHaveBeenCalledOnce();
  expect(database.prepare("SELECT value FROM entries").all()).toEqual([{ value: "cli" }]);
});
