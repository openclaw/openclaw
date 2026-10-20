import { expect, it, vi } from "vitest";
import {
  runSqliteDeferredTransactionSync as deferred,
  runSqliteImmediateTransaction as prepared,
  runSqliteImmediateTransactionSync as immediate,
  runSqliteReadSnapshotSync as snapshot,
  runSqliteReservedTransactionSync as reserved,
  runSqliteSingleStatementSync as single,
  runSqliteWorkerTransactionSync as worker,
} from "../sqlite-transaction.js";
import {
  assertSqliteWorkerCommitReceiptPending as assertPending,
  deferSqliteWorkerCommitReceipt as deferReceipt,
  observeSqliteWorkerCommittedFacts as observeFacts,
  requestSqliteWorkerOperationAdmission as requestAdmission,
  withSqliteWorkerOperationAdmission as withAdmission,
} from "../sqlite-worker-operation-admission.js";
import type { SqliteWorkerOperationContext } from "../sqlite-worker-operation-settlement.js";
import { usePostgresFixture } from "./fixture.test-support.js";

const fixture = usePostgresFixture();

it.each([
  ["immediate", "BEGIN IMMEDIATE"],
  ["deferred", "BEGIN"],
  ["snapshot", "BEGIN"],
] as const)("preserves the %s transaction's exact statement bytes", (mode, begin) => {
  const db = fixture.nativeDatabase();
  const exec = vi.spyOn(db, "exec");
  const run = mode === "immediate" ? immediate : mode === "deferred" ? deferred : snapshot;
  run(db, () => immediate(db, () => undefined));
  expect(exec.mock.calls).toEqual([
    [begin],
    ["SAVEPOINT openclaw_tx_nested"],
    ["RELEASE SAVEPOINT openclaw_tx_nested"],
    ["COMMIT"],
  ]);
});

function postgresFixture() {
  const db = fixture.connection();
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

it.each([
  [false, undefined],
  [false, true],
  [true, undefined],
  [true, true],
] as const)(
  "settles anchored receipts (rollback=%s, source reservations=%s)",
  (rollback, sourceReservations) => {
    const { db } = postgresFixture();
    const admission = fixture.admission((_request, grant) => grant());
    const owner: SqliteWorkerOperationContext = {
      port: admission.port,
      sourceReservations,
    };
    const receipts: unknown[] = [];
    observeFacts(admission, ({ facts }) => receipts.push(facts));
    const write = () =>
      withAdmission(owner, () =>
        immediate(db, () => {
          deferReceipt(db, { value: 7 });
          assertPending(db);
          assertPending(db.anchor);
          expect(owner.committed).toBeUndefined();
          if (rollback) {
            throw new Error("cancel receipt");
          }
        }),
      );
    if (rollback) {
      expect(write).toThrow("cancel receipt");
    } else {
      write();
    }
    admission.service();
    expect(receipts).toEqual(rollback ? [] : [{ value: 7 }]);
    expect(owner.pendingReceipts?.size).toBe(0);
  },
);

it.each(["sqlite", "postgres"] as const)(
  "leaves transaction and commit admission to the domain on %s",
  (engine) => {
    const db = engine === "postgres" ? postgresFixture().db : fixture.nativeDatabase();
    db.exec("CREATE TABLE proof (value INTEGER)");
    const stages: string[] = [];
    const admission = fixture.admission((request, grant) => {
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
    const result = withAdmission({ port: admission.port }, () => {
      requestAdmission({ stage: "transaction", facts: "domain write" });
      return immediate(
        db,
        () => {
          db.exec("INSERT INTO proof (value) VALUES (7)");
          return 7;
        },
        {
          withCommit(commit) {
            requestAdmission({ stage: "commit", facts: "domain write" });
            commit();
          },
        },
      );
    });
    expect(result).toBe(7);
    expect(db.isTransaction).toBe(false);
    expect(stages).toEqual(["transaction", "commit"]);
    expect(admission.failure).toBeUndefined();
  },
);

it.each(["immediate", "deferred", "reserved", "worker", "single-statement"] as const)(
  "uses one locked read-committed transaction for %s writes",
  (mode) => {
    const { db, statements } = postgresFixture();
    const admit = (stage: string) => statements.push(`admit:${stage}`);
    const operation = () => {
      statements.push("body");
      return 7;
    };
    const run = {
      immediate: () => immediate(db, operation),
      deferred: () => deferred(db, operation),
      reserved: () => reserved(db, operation, {}),
      "single-statement": () => single(db, operation),
      worker: () => worker({ database: db, databasePath: "", admit }, operation),
    };
    const result = run[mode]();
    expect(result).toBe(7);
    expect(statements).toEqual(
      mode === "worker"
        ? ["admit:transaction", writeBegin, "body", "admit:commit", "COMMIT"]
        : [writeBegin, "body", "COMMIT"],
    );
  },
);

it("ends a read-only repeatable snapshot without a write receipt and reuses it for nested reads", () => {
  const { db, statements } = postgresFixture();
  expect(snapshot(db, () => snapshot(db, () => "snapshot"))).toBe("snapshot");
  expect(statements).toEqual(["BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY", "ROLLBACK"]);
  expect(db.isTransaction).toBe(false);
});

it("rolls a failed inner write back to its savepoint before the outer commit", () => {
  const { db, statements } = postgresFixture();
  const failure = new Error("inner write refused");
  immediate(db, () => {
    expect(() =>
      immediate(db, () => {
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
    immediate(db, () => 1, {
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
  const result = await prepared(
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
