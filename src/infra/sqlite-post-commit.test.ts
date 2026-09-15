// Post-commit observers are isolated from the durable transaction result:
// every deferred observer runs after COMMIT, and one failing observer never
// fails the committed write nor skips its siblings.
import { afterEach, describe, expect, it } from "vitest";
import { requireNodeSqlite } from "./node-sqlite.js";
import {
  deferSqlitePostCommitPublication,
  stageSqliteTransactionState,
  withSqlitePostCommitPublications,
} from "./sqlite-post-commit.js";
import { runSqliteImmediateTransactionSync } from "./sqlite-transaction.js";

const openDatabases: Array<import("node:sqlite").DatabaseSync> = [];

function createDatabase(): import("node:sqlite").DatabaseSync {
  const { DatabaseSync } = requireNodeSqlite();
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE entries (id TEXT PRIMARY KEY, value TEXT);");
  openDatabases.push(db);
  return db;
}

afterEach(() => {
  for (const db of openDatabases.splice(0)) {
    if (db.isOpen) {
      db.close();
    }
  }
});

describe("sqlite post-commit observer isolation", () => {
  it("runs every publication after commit when one publication throws", () => {
    const db = createDatabase();
    const ran: string[] = [];

    const result = withSqlitePostCommitPublications(db, () =>
      runSqliteImmediateTransactionSync(db, () => {
        db.prepare("INSERT INTO entries VALUES ('a', '1')").run();
        expect(
          deferSqlitePostCommitPublication(db, () => {
            ran.push("first");
            throw new Error("boom-first-publish");
          }),
        ).toBe(true);
        expect(
          deferSqlitePostCommitPublication(db, () => {
            ran.push("second");
          }),
        ).toBe(true);
        return "committed";
      }),
    );

    expect(result).toBe("committed");
    expect(ran).toEqual(["first", "second"]);
    expect(db.prepare("SELECT id FROM entries ORDER BY id").all()).toEqual([{ id: "a" }]);
  });

  it("runs every staged commit and publication when one staged commit throws", () => {
    const db = createDatabase();
    const ran: string[] = [];

    const result = withSqlitePostCommitPublications(db, () =>
      runSqliteImmediateTransactionSync(db, () => {
        db.prepare("INSERT INTO entries VALUES ('b', '1')").run();
        expect(
          stageSqliteTransactionState(db, {
            stage: () => {},
            rollback: () => {},
            commit: () => {
              ran.push("commit-first");
              throw new Error("boom-commit");
            },
          }),
        ).toBe(true);
        expect(
          stageSqliteTransactionState(db, {
            stage: () => {},
            rollback: () => {},
            commit: () => {
              ran.push("commit-second");
            },
          }),
        ).toBe(true);
        expect(
          deferSqlitePostCommitPublication(db, () => {
            ran.push("publish-after-commit");
          }),
        ).toBe(true);
        return "committed";
      }),
    );

    expect(result).toBe("committed");
    expect(ran).toEqual(["commit-first", "commit-second", "publish-after-commit"]);
    expect(db.prepare("SELECT id FROM entries ORDER BY id").all()).toEqual([{ id: "b" }]);
  });

  it("runs every rollback when one rollback throws and preserves the transaction failure", () => {
    const db = createDatabase();
    const rolledBack: string[] = [];
    const failure = new Error("tx failure");

    expect(() =>
      withSqlitePostCommitPublications(db, () =>
        runSqliteImmediateTransactionSync(db, () => {
          db.prepare("INSERT INTO entries VALUES ('c', '1')").run();
          expect(
            stageSqliteTransactionState(db, {
              stage: () => {},
              rollback: () => {
                rolledBack.push("first");
              },
              commit: () => {},
            }),
          ).toBe(true);
          expect(
            stageSqliteTransactionState(db, {
              stage: () => {},
              rollback: () => {
                rolledBack.push("second");
                throw new Error("boom-rollback");
              },
              commit: () => {},
            }),
          ).toBe(true);
          throw failure;
        }),
      ),
    ).toThrow(failure);
    // Rollbacks run in reverse stage order; both must run despite the throw.
    expect(rolledBack).toEqual(["second", "first"]);
    expect(db.prepare("SELECT id FROM entries ORDER BY id").all()).toEqual([]);
  });
});
