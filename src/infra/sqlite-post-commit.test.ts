import { afterEach, expect, it } from "vitest";
import { requireNodeSqlite } from "./node-sqlite.js";
import {
  deferSqlitePostCommitPublication,
  stageSqliteCommittedPublication,
  stageSqliteTransactionState,
  withSqlitePostCommitPublications,
  type SqliteCommittedPublication,
} from "./sqlite-post-commit.js";
import { runSqliteImmediateTransactionSync } from "./sqlite-transaction.js";

const databases: import("node:sqlite").DatabaseSync[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) {
    database.close();
  }
});

function fixture() {
  const { DatabaseSync } = requireNodeSqlite();
  const database = new DatabaseSync(":memory:");
  databases.push(database);
  database.exec("CREATE TABLE receipt_test (id TEXT PRIMARY KEY)");
  const rows = () => database.prepare("SELECT id FROM receipt_test ORDER BY id").all();
  const write = (id: string) => database.prepare("INSERT INTO receipt_test VALUES (?)").run(id);
  const transaction = <T>(operation: () => T) =>
    withSqlitePostCommitPublications(database, () =>
      runSqliteImmediateTransactionSync(database, operation),
    );
  return { database, rows, write, transaction };
}

it("retains committed success and delivers later observers when a notification throws", () => {
  const { database, rows, write, transaction } = fixture();
  const seen: unknown[] = [];
  const result = transaction(() => {
    write("committed");
    deferSqlitePostCommitPublication(database, () => {
      throw new Error("notification unavailable");
    });
    deferSqlitePostCommitPublication(database, () => seen.push(rows()));
    return "saved";
  });
  expect(result).toBe("saved");
  expect(rows()).toEqual([{ id: "committed" }]);
  expect(seen).toEqual([[{ id: "committed" }]]);
});

it.each(["facts", "projection"] as const)(
  "fences failed %s installation before public observers without rolling back the write",
  (phase) => {
    const { database, rows, write, transaction } = fixture();
    const facts = new Map<string, string>();
    const observed: unknown[] = [];
    const publication = (key: string): SqliteCommittedPublication => ({
      installFacts() {
        facts.set(key, "committed");
        if (key === "first" && phase === "facts") {
          throw new Error("partial installation");
        }
      },
      installProjection() {
        if (key === "first" && phase === "projection") {
          throw new Error("projection unavailable");
        }
      },
      invalidate() {
        facts.set(key, "unknown");
      },
      notify() {
        observed.push([...facts]);
      },
    });
    expect(
      transaction(() => {
        for (const key of ["first", "second"]) {
          write(key);
          expect(stageSqliteCommittedPublication(database, publication(key))).toBe(true);
        }
        return "saved";
      }),
    ).toBe("saved");
    expect(rows()).toEqual([{ id: "first" }, { id: "second" }]);
    expect(observed).toEqual([
      [
        ["first", "unknown"],
        ["second", "committed"],
      ],
      [
        ["first", "unknown"],
        ["second", "committed"],
      ],
    ]);
  },
);

it("installs every commit receipt even if a prior owner cannot fence its failed facts", () => {
  const { database, rows, write, transaction } = fixture();
  let receipt: unknown;
  let notified = false;
  transaction(() => {
    write("committed");
    stageSqliteTransactionState(database, {
      stage() {},
      rollback() {},
      commit() {
        throw new Error("legacy installer failed");
      },
    });
    stageSqliteTransactionState(database, {
      stage() {},
      rollback() {},
      commit() {
        receipt = rows();
      },
    });
    deferSqlitePostCommitPublication(database, () => {
      notified = true;
    });
  });
  expect(receipt).toEqual([{ id: "committed" }]);
  expect(notified).toBe(false);
});

it.each(["nested", "outer", "commit"] as const)(
  "discards tentative receipt publications on %s rollback",
  (boundary) => {
    const { database, rows, write, transaction } = fixture();
    const observed: string[] = [];
    const publish = (key: string) => {
      write(key);
      stageSqliteCommittedPublication(database, {
        installFacts() {
          observed.push(`facts:${key}`);
        },
        installProjection() {
          observed.push(`projection:${key}`);
        },
        invalidate() {
          observed.push(`unknown:${key}`);
        },
        notify() {
          observed.push(`notify:${key}`);
        },
      });
    };
    if (boundary === "commit") {
      database.exec(
        "PRAGMA foreign_keys = ON; CREATE TABLE child (id TEXT REFERENCES receipt_test(id) DEFERRABLE INITIALLY DEFERRED)",
      );
    }
    const run = () =>
      transaction(() => {
        publish("outer");
        expect(() =>
          transaction(() => {
            publish("rolled-back");
            throw new Error("nested failure");
          }),
        ).toThrow("nested failure");
        transaction(() => publish("inner"));
        expect(observed).toEqual([]);
        if (boundary === "outer") {
          throw new Error("outer failure");
        }
        if (boundary === "commit") {
          database.prepare("INSERT INTO child VALUES (?)").run("missing");
        }
      });
    if (boundary === "nested") {
      run();
      expect(rows()).toEqual([{ id: "inner" }, { id: "outer" }]);
      expect(observed).toEqual([
        "facts:outer",
        "facts:inner",
        "projection:outer",
        "projection:inner",
        "notify:outer",
        "notify:inner",
      ]);
    } else {
      expect(run).toThrow();
      expect(rows()).toEqual([]);
      expect(observed).toEqual([]);
    }
  },
);
