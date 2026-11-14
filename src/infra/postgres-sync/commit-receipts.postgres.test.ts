import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { getEnvironmentData, receiveMessageOnPort } from "node:worker_threads";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
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
import * as bridgePrestart from "./bridge-prestart.js";
import { PostgresSyncConnection } from "./connection.js";
import type { BridgeRequest, PostgresBridge } from "./protocol.js";

vi.mock("node:worker_threads", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:worker_threads")>();
  return { ...actual, receiveMessageOnPort: vi.fn(actual.receiveMessageOnPort) };
});

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
      owner,
      publications,
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
    vi.restoreAllMocks();
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

  it("does not publish or replay a committed write after losing its host COMMIT reply", async () => {
    const actual =
      await vi.importActual<typeof import("node:worker_threads")>("node:worker_threads");
    const create = bridgePrestart.createPostgresBridge;
    let bridge: PostgresBridge | undefined;
    vi.spyOn(bridgePrestart, "createPostgresBridge").mockImplementation((params) => {
      bridge = create(params);
      return bridge;
    });
    const { db, prefix, ...operation } = admitted();
    expect(bridge).toBeDefined();
    const port = bridge!.port;
    const sent = vi.spyOn(port, "postMessage");
    let dropped = 0;
    vi.mocked(receiveMessageOnPort).mockImplementation((source) => {
      const received = actual.receiveMessageOnPort(source);
      const request: BridgeRequest | undefined = sent.mock.calls.at(-1)?.[0];
      if (
        source === port &&
        request?.operation === "query" &&
        request.sql === "COMMIT" &&
        received?.message.id === request.id
      ) {
        expect(received.message.result.command).toBe("COMMIT");
        dropped++;
        // Consume the real bridge reply without delivering it to the synchronous caller.
        return undefined;
      }
      return received;
    });
    const id = `${prefix}committed`;
    try {
      expect(() =>
        operation.execute(() =>
          db.runTransaction(() => {
            insert(db, id);
            deferSqliteWorkerCommitReceipt(db, { kind: "saved-entry", id });
          }),
        ),
      ).toThrow(expect.objectContaining({ code: "outcome-unknown" }));
      expect(dropped).toBe(1);
      expect(db.isOpen).toBe(false);
      expect(() => run(() => insert(db, id))).toThrow("outcome unknown");
      expect(
        (await admin.query(`SELECT id FROM "${schema}".entries WHERE id = $1`, [id])).rows,
      ).toEqual([{ id }]);
      operation.admission.service();
      expect(operation.owner.pendingReceipts?.size).toBe(0);
      expect(operation.admission.committed).toBeUndefined();
      expect(operation.publications).toEqual([]);
    } finally {
      vi.mocked(receiveMessageOnPort).mockImplementation(actual.receiveMessageOnPort);
    }
  });
});
