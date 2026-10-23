import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { getEnvironmentData } from "node:worker_threads";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { withEngineStoreAdmission } from "../database-engine/admission-scope.js";
import {
  createSqliteWorkerOperationAdmission,
  deferSqliteWorkerCommitReceipt,
  observeSqliteWorkerCommittedFacts,
  withSqliteWorkerOperationAdmission,
} from "../sqlite-worker-operation-admission.js";
import {
  settleSqliteWorkerOperationContext,
  type SqliteWorkerOperationContext,
} from "../sqlite-worker-operation-settlement.js";
import { PostgresSyncConnection } from "./connection.js";

const configured = getEnvironmentData("openclaw.test.workboard.connection");
const connection = typeof configured === "string" ? configured : undefined;

describe.skipIf(!connection)("PostgreSQL domain commit receipts", () => {
  const admin = new Client({ connectionString: connection });
  const schema = `receipts_${randomUUID().replaceAll("-", "")}`;
  const cleanups: Array<() => void> = [];
  const run = withEngineStoreAdmission;

  function anchor() {
    const database = new DatabaseSync(":memory:");
    cleanups.push(() => database.close());
    return database;
  }

  function open(database = anchor()) {
    const db = run(() => new PostgresSyncConnection(connection!, schema, database, schema));
    cleanups.push(() => run(() => db.close()));
    return db;
  }

  function admitted() {
    const admission = createSqliteWorkerOperationAdmission((_request, grant) => grant());
    const owner: SqliteWorkerOperationContext = { port: admission.port };
    const publications: unknown[] = [];
    observeSqliteWorkerCommittedFacts(admission, ({ facts }) => publications.push(facts));
    cleanups.push(() => admission.finish());
    return {
      admission,
      publications,
      execute: <T>(operation: () => T) =>
        run(() => withSqliteWorkerOperationAdmission(owner, operation)),
      settle() {
        settleSqliteWorkerOperationContext(owner, "completed");
        admission.service();
      },
    };
  }

  function insert(db: PostgresSyncConnection, id: string) {
    db.prepare("INSERT INTO entries (id) VALUES (?)").run(id);
  }

  function rows(db: PostgresSyncConnection, prefix: string) {
    return run(() =>
      db.prepare("SELECT id FROM entries WHERE id LIKE ? ORDER BY id").all(`${prefix}%`),
    );
  }

  beforeAll(async () => {
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"; CREATE TABLE "${schema}".entries (id text)`);
  });

  afterEach(() => {
    for (const cleanup of cleanups.splice(0).toReversed()) {
      cleanup();
    }
  });

  afterAll(async () => {
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  });

  it.each(["transaction", "autocommit"] as const)(
    "persists an untyped %s without publishing domain facts",
    (mode) => {
      const prefix = `${randomUUID()}:`;
      const db = open();
      const operation = admitted();
      operation.execute(() => {
        if (mode === "transaction") {
          db.runTransaction(() => insert(db, `${prefix}saved`));
        } else {
          insert(db, `${prefix}saved`);
        }
      });
      run(() => db.close());
      expect(rows(open(), prefix)).toEqual([{ id: `${prefix}saved` }]);
      operation.settle();
      expect(operation.admission.committed).toBeUndefined();
      expect(operation.publications).toEqual([]);
      expect(operation.admission.settlement).toEqual({ kind: "completed" });
    },
  );

  it.each(
    (["same", "other"] as const).flatMap((destination) =>
      (["transaction", "autocommit"] as const).map((mode) => ({ destination, mode })),
    ),
  )(
    "retains typed facts after an untyped $mode on the $destination anchor",
    ({ destination, mode }) => {
      const prefix = `${randomUUID()}:`;
      const db = open();
      const later = destination === "same" ? db : open();
      const operation = admitted();
      const facts = { kind: "saved-entry", id: `${prefix}typed` };
      operation.execute(() => {
        db.runTransaction(() => {
          insert(db, facts.id);
          deferSqliteWorkerCommitReceipt(db, facts);
        });
        if (mode === "transaction") {
          later.runTransaction(() => insert(later, `${prefix}untyped`));
        } else {
          insert(later, `${prefix}untyped`);
        }
      });
      expect(rows(later, prefix)).toEqual([{ id: facts.id }, { id: `${prefix}untyped` }]);
      operation.settle();
      expect(operation.admission.committed).toEqual({ facts });
      expect(operation.publications).toEqual([facts]);
      expect(operation.admission.settlement).toEqual({ kind: "completed", committed: { facts } });
    },
  );

  it("does not replace rolled-back inner facts with an untyped outer receipt", () => {
    const prefix = `${randomUUID()}:`;
    const db = open();
    const operation = admitted();
    operation.execute(() =>
      db.runTransaction(() => {
        expect(() =>
          db.runTransaction(() => {
            insert(db, `${prefix}rolled-back`);
            deferSqliteWorkerCommitReceipt(db, { kind: "saved-entry", id: `${prefix}rolled-back` });
            throw new Error("Cancel inner write");
          }),
        ).toThrow("Cancel inner write");
        insert(db, `${prefix}saved`);
      }),
    );
    expect(rows(db, prefix)).toEqual([{ id: `${prefix}saved` }]);
    operation.settle();
    expect(operation.admission.committed).toBeUndefined();
    expect(operation.publications).toEqual([]);
    expect(operation.admission.settlement).toEqual({ kind: "completed" });
  });

  it("delivers explicitly staged empty facts at settlement without a mutation", () => {
    const db = open();
    const operation = admitted();
    const facts = { kind: "saved-entries", ids: [] };
    operation.execute(() =>
      db.runTransaction(() => deferSqliteWorkerCommitReceipt(db, facts, "settlement")),
    );
    expect(operation.admission.committed).toBeUndefined();
    operation.settle();
    expect(operation.admission.committed).toEqual({ facts });
    expect(operation.publications).toEqual([facts]);
    expect(operation.admission.settlement).toEqual({ kind: "completed", committed: { facts } });
  });
});
