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

  function open() {
    const database = new DatabaseSync(":memory:");
    cleanups.push(() => database.close());
    const db = run(() => new PostgresSyncConnection(connection!, schema, database, schema));
    cleanups.push(() => run(() => db.close()));
    return db;
  }

  function admitted() {
    const db = open();
    const admission = createSqliteWorkerOperationAdmission((_request, grant) => grant());
    const owner: SqliteWorkerOperationContext = { port: admission.port };
    const publications: unknown[] = [];
    observeSqliteWorkerCommittedFacts(admission, ({ facts }) => publications.push(facts));
    cleanups.push(() => admission.finish());
    return {
      db,
      prefix: `${randomUUID()}:`,
      admission,
      execute: <T>(operation: () => T) =>
        run(() => withSqliteWorkerOperationAdmission(owner, operation)),
      settle(facts?: unknown) {
        settleSqliteWorkerOperationContext(owner, "completed");
        admission.service();
        const committed = facts === undefined ? undefined : { facts };
        expect(admission.committed).toEqual(committed);
        expect(publications).toEqual(facts === undefined ? [] : [facts]);
        expect(admission.settlement).toEqual(
          facts === undefined ? { kind: "completed" } : { kind: "completed", committed },
        );
      },
    };
  }

  function insert(db: PostgresSyncConnection, id: string) {
    db.prepare("INSERT INTO entries (id) VALUES (?)").run(id);
  }

  function write(db: PostgresSyncConnection, id: string, mode: string) {
    if (mode === "transaction") {
      db.runTransaction(() => insert(db, id));
    } else {
      insert(db, id);
    }
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
      const { db, prefix, ...operation } = admitted();
      operation.execute(() => write(db, `${prefix}saved`, mode));
      run(() => db.close());
      expect(rows(open(), prefix)).toEqual([{ id: `${prefix}saved` }]);
      operation.settle();
    },
  );

  it.each([
    ["same", "transaction"],
    ["same", "autocommit"],
    ["other", "transaction"],
    ["other", "autocommit"],
  ])("retains typed facts on the %s anchor after an untyped %s", (destination, mode) => {
    const { db, prefix, ...operation } = admitted();
    const later = destination === "same" ? db : open();
    const facts = { kind: "saved-entry", id: `${prefix}typed` };
    operation.execute(() => {
      db.runTransaction(() => {
        insert(db, facts.id);
        deferSqliteWorkerCommitReceipt(db, facts);
      });
      write(later, `${prefix}untyped`, mode);
    });
    expect(rows(later, prefix)).toEqual([{ id: facts.id }, { id: `${prefix}untyped` }]);
    operation.settle(facts);
  });

  it("does not replace rolled-back inner facts with an untyped outer receipt", () => {
    const { db, prefix, ...operation } = admitted();
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
  });

  it("delivers explicitly staged empty facts at settlement without a mutation", () => {
    const { db, ...operation } = admitted();
    const facts = { kind: "saved-entries", ids: [] };
    operation.execute(() =>
      db.runTransaction(() => deferSqliteWorkerCommitReceipt(db, facts, "settlement")),
    );
    expect(operation.admission.committed).toBeUndefined();
    operation.settle(facts);
  });
});
