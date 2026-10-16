import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  runSqliteDeferredTransactionSync,
  runSqliteImmediateTransaction,
  runSqliteImmediateTransactionSync,
  runSqliteReadSnapshotSync,
  runSqliteReservedTransactionSync,
  runSqliteSingleStatementSync,
  runSqliteWorkerTransactionSync,
} from "../sqlite-transaction.js";
import {
  assertSqliteWorkerCommitReceiptPending,
  createSqliteWorkerOperationAdmission,
  deferSqliteWorkerCommitReceipt,
  observeSqliteWorkerCommittedFacts,
  requestSqliteWorkerOperationAdmission,
  withSqliteWorkerOperationAdmission,
} from "../sqlite-worker-operation-admission.js";
import type { SqliteWorkerOperationContext } from "../sqlite-worker-operation-settlement.js";
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
  Object.defineProperty(db, Symbol.for("openclaw.postgres-sync-connection"), { value: true });
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
  it.each([
    { rollback: false, sourceReservations: false },
    { rollback: false, sourceReservations: true },
    { rollback: true, sourceReservations: false },
    { rollback: true, sourceReservations: true },
  ])(
    "settles one receipt on its anchor (rollback: $rollback, source reservations: $sourceReservations)",
    ({ rollback, sourceReservations }) => {
      const { db } = postgresFixture();
      const admission = createSqliteWorkerOperationAdmission((_request, grant) => grant());
      const owner: SqliteWorkerOperationContext = {
        port: admission.port,
        sourceReservations: sourceReservations ? true : undefined,
      };
      const receipts: unknown[] = [];
      observeSqliteWorkerCommittedFacts(admission, ({ facts }) => receipts.push(facts));
      const write = () =>
        withSqliteWorkerOperationAdmission(owner, () =>
          runSqliteImmediateTransactionSync(db, () => {
            deferSqliteWorkerCommitReceipt(db, { value: 7 });
            assertSqliteWorkerCommitReceiptPending(db);
            assertSqliteWorkerCommitReceiptPending(db.anchor);
            expect(owner.committed).toBeUndefined();
            if (rollback) {
              throw new Error("cancel receipt");
            }
          }),
        );
      try {
        if (rollback) {
          expect(write).toThrow("cancel receipt");
        } else {
          write();
        }
        admission.service();
        if (rollback) {
          expect(receipts).toEqual([]);
        } else {
          expect(receipts).toEqual([{ value: 7 }]);
        }
        expect(owner.pendingReceipts?.size).toBe(0);
      } finally {
        admission.finish();
      }
    },
  );

  it.each(["sqlite", "postgres"] as const)(
    "leaves transaction and commit admission to the domain on %s",
    (engine) => {
      const db = engine === "postgres" ? postgresFixture().db : nativeDatabase();
      db.exec("CREATE TABLE proof (value INTEGER)");
      const stages: string[] = [];
      const admission = createSqliteWorkerOperationAdmission((request, grant) => {
        if (request.facts !== "domain write") {
          throw new Error("The domain already owns admission");
        }
        stages.push(request.stage);
        grant();
      });
      vi.spyOn(Atomics, "wait").mockImplementation(() => {
        admission.service();
        return "ok";
      });
      try {
        const result = withSqliteWorkerOperationAdmission({ port: admission.port }, () => {
          requestSqliteWorkerOperationAdmission({ stage: "transaction", facts: "domain write" });
          return runSqliteImmediateTransactionSync(
            db,
            () => {
              db.exec("INSERT INTO proof (value) VALUES (7)");
              return 7;
            },
            {
              withCommit(commit) {
                requestSqliteWorkerOperationAdmission({ stage: "commit", facts: "domain write" });
                commit();
              },
            },
          );
        });
        expect(result).toBe(7);
        expect(db.isTransaction).toBe(false);
        expect(stages).toEqual(["transaction", "commit"]);
        expect(admission.failure).toBeUndefined();
      } finally {
        admission.finish();
      }
    },
  );

  it.each(["immediate", "deferred", "reserved", "worker", "single-statement"] as const)(
    "uses one locked read-committed transaction for %s writes",
    (mode) => {
      const { db, statements } = postgresFixture();
      const admit = vi.fn((stage: string) => statements.push(`admit:${stage}`));
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
              : mode === "single-statement"
                ? runSqliteSingleStatementSync(db, operation)
                : runSqliteWorkerTransactionSync(
                    { database: db, databasePath: "", admit },
                    operation,
                  );
      expect(result).toBe(7);
      expect(statements).toEqual(
        mode === "worker"
          ? ["admit:transaction", writeBegin, "body", "admit:commit", "COMMIT"]
          : [writeBegin, "body", "COMMIT"],
      );
      if (mode === "worker") {
        expect(admit.mock.calls).toEqual([["transaction"], ["commit"]]);
      }
    },
  );

  it("ends a read-only repeatable snapshot without a write receipt and reuses it for nested reads", () => {
    const { db, statements } = postgresFixture();
    expect(
      runSqliteReadSnapshotSync(db, () => runSqliteReadSnapshotSync(db, () => "snapshot")),
    ).toBe("snapshot");
    expect(statements).toEqual(["BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY", "ROLLBACK"]);
    expect(db.isTransaction).toBe(false);
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
