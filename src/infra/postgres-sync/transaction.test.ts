import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  runSqliteDeferredTransactionSync,
  runSqliteImmediateTransaction,
  runSqliteImmediateTransactionSync,
  runSqliteReadSnapshotSync,
  runSqliteReservedTransactionSync,
  runSqliteWorkerTransactionSync,
} from "../sqlite-transaction.js";
import { PostgresSyncConnection } from "./connection.js";

const anchors: DatabaseSync[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const anchor of anchors.splice(0)) {
    anchor.close();
  }
});

function nativeDatabase(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  anchors.push(db);
  return db;
}

function postgresFixture() {
  // The transaction owner sees the real connection type; bridge/server behavior
  // is covered separately. Record its SQL protocol without starting a worker.
  const db = Object.create(PostgresSyncConnection.prototype) as PostgresSyncConnection;
  Object.defineProperties(db, {
    anchor: { value: nativeDatabase() },
    advisoryLockKey: { value: -42n },
  });
  db.isOpen = true;
  db.isTransaction = false;
  const statements: string[] = [];
  db.exec = (sql) => {
    statements.push(sql);
    if (sql.startsWith("BEGIN")) {
      db.isTransaction = true;
    } else if (sql === "COMMIT" || sql === "ROLLBACK") {
      db.isTransaction = false;
    }
  };
  return { db, statements };
}

const writeBegin = "BEGIN ISOLATION LEVEL READ COMMITTED; SELECT pg_advisory_xact_lock(-42)";

describe("experimental PostgreSQL transaction protocol", () => {
  it.each(["immediate", "deferred", "reserved", "worker"] as const)(
    "uses one locked read-committed transaction for %s writes",
    (mode) => {
      const { db, statements } = postgresFixture();
      const admit = vi.fn();
      const operation = () => {
        statements.push("body");
        return 7;
      };
      const result =
        mode === "immediate"
          ? runSqliteImmediateTransactionSync(db, operation)
          : mode === "deferred"
            ? runSqliteDeferredTransactionSync(db, operation)
            : mode === "reserved"
              ? runSqliteReservedTransactionSync(db, operation, {})
              : runSqliteWorkerTransactionSync(
                  { database: db, databasePath: "", admit },
                  operation,
                );
      expect(result).toBe(7);
      expect(statements).toEqual([writeBegin, "body", "COMMIT"]);
      if (mode === "worker") {
        expect(admit.mock.calls).toEqual([["transaction"], ["commit"]]);
      }
    },
  );

  it("uses a read-only repeatable snapshot and reuses it for nested reads", () => {
    const { db, statements } = postgresFixture();
    expect(
      runSqliteReadSnapshotSync(db, () => runSqliteReadSnapshotSync(db, () => "snapshot")),
    ).toBe("snapshot");
    expect(statements).toEqual(["BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY", "COMMIT"]);
  });

  it("rolls a failed inner write back to its savepoint before the outer commit", () => {
    const { db, statements } = postgresFixture();
    const failure = new Error("inner write refused");
    runSqliteImmediateTransactionSync(db, () => {
      expect(() =>
        runSqliteImmediateTransactionSync(db, () => {
          throw failure;
        }),
      ).toThrow(failure);
      expect(db.isTransaction).toBe(true);
    });
    expect(statements).toEqual([
      writeBegin,
      "SAVEPOINT openclaw_tx_nested",
      "ROLLBACK TO SAVEPOINT openclaw_tx_nested",
      "RELEASE SAVEPOINT openclaw_tx_nested",
      "COMMIT",
    ]);
  });

  it("runs the commit authority guard and rolls back when it refuses", () => {
    const { db, statements } = postgresFixture();
    const refusal = new Error("authority revoked");
    expect(() =>
      runSqliteImmediateTransactionSync(db, () => 1, {
        withCommit() {
          throw refusal;
        },
      }),
    ).toThrow(refusal);
    expect(statements).toEqual([writeBegin, "ROLLBACK"]);
    expect(db.isTransaction).toBe(false);
  });

  it("prepares before asynchronous admission and commits only inside its guard", async () => {
    const { db, statements } = postgresFixture();
    const result = await runSqliteImmediateTransaction(
      db,
      async () => {
        statements.push("prepare");
        return () => "result";
      },
      {
        withCommit(commit) {
          statements.push("guard");
          commit();
        },
      },
      (write) => {
        statements.push("admit");
        return write();
      },
    );
    expect(result).toBe("result");
    expect(statements).toEqual(["prepare", "admit", writeBegin, "guard", "COMMIT"]);
  });
});

describe("SQLite transaction SQL preservation", () => {
  it.each([
    ["immediate", "BEGIN IMMEDIATE"],
    ["deferred", "BEGIN"],
    ["snapshot", "BEGIN"],
  ] as const)("preserves the %s transaction's exact statement bytes", (mode, begin) => {
    const db = nativeDatabase();
    const exec = vi.spyOn(db, "exec");
    const run =
      mode === "immediate"
        ? runSqliteImmediateTransactionSync
        : mode === "deferred"
          ? runSqliteDeferredTransactionSync
          : runSqliteReadSnapshotSync;
    run(db, () => runSqliteImmediateTransactionSync(db, () => undefined));
    expect(exec.mock.calls).toEqual([
      [begin],
      ["SAVEPOINT openclaw_tx_nested"],
      ["RELEASE SAVEPOINT openclaw_tx_nested"],
      ["COMMIT"],
    ]);
  });
});
