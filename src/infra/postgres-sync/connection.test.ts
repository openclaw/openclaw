import { MessageChannel, receiveMessageOnPort, threadId } from "node:worker_threads";
import { expect, it, vi } from "vitest";
import { withEngineStoreAdmission } from "../database-engine/admission-scope.js";
import { readSqliteDatabaseScopedWriteToken as readToken } from "../sqlite-database-admission.js";
import { stageSqliteTransactionState } from "../sqlite-post-commit.js";
import { readSqliteNativeMutationRevision as readRevision } from "../sqlite-schema-facts.js";
import {
  runSqliteImmediateTransaction as prepared,
  runSqliteImmediateTransactionSync as immediate,
  runSqliteReservedTransactionSync as reserved,
  runSqliteWorkerTransactionSync as worker,
} from "../sqlite-transaction.js";
import { hasSqliteWorkerOutcomeUnknown } from "../sqlite-worker-contract.js";
import {
  assertSqliteWorkerCommitReceiptPending as assertPending,
  deferSqliteWorkerCommitReceipt as deferReceipt,
  observeSqliteWorkerCommittedFacts,
  withSqliteWorkerOperationAdmission as withAdmission,
} from "../sqlite-worker-operation-admission.js";
import type { SqliteWorkerOperationContext } from "../sqlite-worker-operation-settlement.js";
import * as bridgePrestart from "./bridge-prestart.js";
import { PostgresSyncConnection } from "./connection.js";
import { usePostgresFixture } from "./fixture.test-support.js";
import type { BridgeReply, BridgeRequest, PostgresErrorData } from "./protocol.js";
import { observeStatementEvents } from "./sql.test-support.js";

const harness = usePostgresFixture();
const writeBegin = "BEGIN ISOLATION LEVEL READ COMMITTED; SELECT pg_advisory_xact_lock(-42)";

function transactionFixture() {
  const db = harness.connection();
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

function transportFixture(
  initialMode: "normal" | "spurious" | "mismatched" | "missing" | "timeout" | "service-death",
) {
  let mode = initialMode;
  let command: string | undefined;
  let queryError: PostgresErrorData | undefined;
  const { port1, port2 } = new MessageChannel();
  const control = new Int32Array(new SharedArrayBuffer(8));
  control.set([1, 1]);
  const service = new Int32Array(new SharedArrayBuffer(8));
  // Exercise the connection over real ports; live tests cover worker startup and admission.
  const db = harness.connection();
  Object.assign(db, {
    bridge: { port: port1, control, service, requestId: 1 },
  });
  const sent = vi.spyOn(port1, "postMessage");
  const waits: Array<{ observed: number | bigint; timeout: number | undefined }> = [];
  let now = 0;
  let wallNow = 0;
  vi.spyOn(Date, "now").mockImplementation(() => wallNow);
  let wakes = 0;
  let pending: BridgeRequest | undefined;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  vi.spyOn(Atomics, "wait").mockImplementation((state, index, observed, timeout) => {
    if (index === 1) {
      return "not-equal";
    }
    const received = receiveMessageOnPort(port2)?.message as BridgeRequest | undefined;
    if (received) {
      pending = received;
      wakes = 0;
    }
    if (!pending) {
      throw new Error("No request was sent to the bridge");
    }
    const query = pending.operation === "query" ? pending : undefined;
    if (query) {
      waits.push({ observed, timeout });
      if (mode === "spurious" && wakes++ === 0) {
        Atomics.notify(control, index);
        now += 1;
        return "ok";
      }
      if (mode === "timeout" || mode === "service-death") {
        if (mode === "service-death") {
          Atomics.store(service, 1, 1);
        }
        now += timeout ?? 0;
        return "timed-out";
      }
    }
    const id = pending.id ?? 1;
    if (mode !== "missing" || !query) {
      const sql = query?.sql ?? "";
      const reply: BridgeReply =
        pending.operation === "release"
          ? { id, reusable: !db.isTransaction }
          : queryError && query
            ? { id, error: queryError }
            : {
                id: mode === "mismatched" && query ? id + 1 : id,
                result: {
                  inTransaction: /^\s*BEGIN\b/i.test(sql)
                    ? true
                    : /^\s*(?:COMMIT|ROLLBACK)\s*;?\s*$/i.test(sql)
                      ? false
                      : db.isTransaction,
                  command,
                  mutation: /^(?:INSERT|UPDATE|DELETE|MERGE)$/.test(command ?? "")
                    ? "scoped"
                    : undefined,
                  rows: [{ value: 7 }],
                  rowCount: 1,
                  fields: [{ name: "value", dataTypeID: 23 }],
                },
              };
      port2.postMessage(reply);
    }
    Atomics.store(control, 0, id);
    return "ok";
  });
  harness.cleanups.push(() => {
    mode = "normal";
    try {
      db.close();
    } catch {
      // The pre-fix implementation can also fail while retiring a poisoned fixture.
    }
    port1.close();
    port2.close();
  });
  return {
    db,
    sent,
    waits,
    elapse: (ms: number) => {
      now += ms;
      wallNow += ms;
    },
    suspend: (ms: number) => (wallNow += ms),
    normal: () => (mode = "normal"),
    dropReplies: () => (mode = "missing"),
    command: (value: string) => (command = value),
    rejectQuery: (error: PostgresErrorData) => (queryError = error),
  };
}

it.each([0, 999, 1000, 1001])("validates reuse after %d idle ms", (idleMs) => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const fixture = transportFixture("normal");
  const params = {
    url: "postgresql://localhost/synthetic",
    schema: "schema_a",
    storeId: "store_a",
  };
  Object.assign(fixture.db, {
    schema: params.schema,
    reuseKey: bridgePrestart.postgresBridgeReuseKey(params),
  });
  const create = vi.spyOn(bridgePrestart, "createPostgresBridge").mockImplementation(() => {
    throw new Error("Unexpected physical connection");
  });
  let next: PostgresSyncConnection | undefined;
  try {
    withEngineStoreAdmission(() => fixture.db.prepare("SELECT 7 AS value").get());
    fixture.sent.mockClear();
    fixture.db.releaseIdleTransport();
    fixture.elapse(idleMs);
    const reader = withEngineStoreAdmission(
      () =>
        new PostgresSyncConnection(params.url, "schema_b", harness.nativeDatabase(), "store_b", {
          reuse: true,
        }),
    );
    next = reader;
    expect(create).not.toHaveBeenCalled();
    expect(fixture.sent).not.toHaveBeenCalled();
    const read = () => withEngineStoreAdmission(() => reader.prepare("SELECT 7 AS value").get());
    expect([read(), read()]).toEqual([{ value: 7 }, { value: 7 }]);
    expect(fixture.sent.mock.calls.map(([request]) => request)).toEqual([
      {
        operation: "query",
        schema: "schema_b",
        sql: "SELECT 7 AS value",
        parameters: [],
        reconnectIfIdle: true,
        ...(idleMs >= 1000 ? { validateIfIdle: true } : {}),
        id: 3,
      },
      {
        operation: "query",
        schema: "schema_b",
        sql: "SELECT 7 AS value",
        parameters: [],
        reconnectIfIdle: true,
        id: 4,
      },
    ]);
  } finally {
    next?.close();
    vi.advanceTimersByTime(3 * 60_000);
    vi.useRealTimers();
  }
});

it("validates retained idle connections after suspended wall time, never inside a transaction", () => {
  const fixture = transportFixture("normal");
  fixture.db.exec("SELECT 7");
  fixture.suspend(2 * 60 * 60_000);
  fixture.db.exec("BEGIN");
  fixture.suspend(2 * 60 * 60_000);
  fixture.db.exec("SELECT 8");
  fixture.command("COMMIT");
  fixture.db.exec("COMMIT");
  fixture.db.exec("SELECT 9");
  expect(
    fixture.sent.mock.calls.map(([request]) => ({
      sql: request.sql,
      reconnect: request.reconnectIfIdle === true,
      validate: request.validateIfIdle === true,
    })),
  ).toEqual([
    { sql: "SELECT 7", reconnect: false, validate: false },
    { sql: "BEGIN", reconnect: true, validate: true },
    { sql: "SELECT 8", reconnect: false, validate: false },
    { sql: "COMMIT", reconnect: false, validate: false },
    { sql: "SELECT 9", reconnect: true, validate: false },
  ]);
});

it("checks transport status after a query error instead of reusing an earlier idle reply", () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const fixture = transportFixture("normal");
  Object.assign(fixture.db, { reuseKey: "failed-query" });
  try {
    withEngineStoreAdmission(() => fixture.db.prepare("SELECT 7 AS value").get());
    fixture.rejectQuery({ name: "error", message: "duplicate", code: "23505" });
    expect(() =>
      withEngineStoreAdmission(() => fixture.db.exec("INSERT INTO entries VALUES (7)")),
    ).toThrow("UNIQUE constraint failed");
    fixture.sent.mockClear();
    fixture.db.releaseIdleTransport();
    expect(fixture.sent.mock.calls.map(([request]) => request)).toEqual([
      { operation: "release", id: 4 },
    ]);
  } finally {
    vi.advanceTimersByTime(3 * 60_000);
    vi.useRealTimers();
  }
});

it("reports an invalid DSN promptly with connection repair guidance", () => {
  const anchor = harness.nativeDatabase();
  const started = performance.now();
  expect(() =>
    withEngineStoreAdmission(
      () => new PostgresSyncConnection("postgresql://[invalid", "unused", anchor, "unused"),
    ),
  ).toThrowError(
    expect.objectContaining({
      name: "PostgresConnectionError",
      message: expect.stringContaining(
        "Check database.postgres.connection, network, and credentials",
      ),
    }),
  );
  expect(performance.now() - started).toBeLessThan(10_000);
});

it.each([
  ["COMMIT", "COMMIT", undefined],
  ["ROLLBACK", "ROLLBACK", undefined],
  ["ROLLBACK", "COMMIT", "rolled back instead of committing"],
  [
    undefined,
    "UPDATE entries SET value = 8",
    "PostgreSQL connection lost; transaction rolled back",
  ],
] as const)("retains the anchor token for %s replying to %s", (command, sql, error) => {
  const fixture = transportFixture(command ? "normal" : "missing");
  if (command) {
    fixture.command(command);
  }
  fixture.db.isTransaction = true;
  const before = readToken(fixture.db.anchor, "entry");
  const run = () => fixture.db.exec(sql);
  if (error) {
    expect(run).toThrow(error);
  } else {
    run();
  }
  expect(readToken(fixture.db.anchor, "entry")).toBe(before);
});

it("invalidates local mutation witnesses inside a transaction and across rollback", () => {
  const fixture = transportFixture("normal");
  fixture.db.isTransaction = true;
  const before = readRevision(fixture.db);
  fixture.command("UPDATE");
  fixture.db.exec("UPDATE records SET value = 1");
  const written = readRevision(fixture.db);
  expect(written).not.toBe(before);
  fixture.command("SELECT");
  fixture.db.exec("SELECT 1");
  expect(readRevision(fixture.db)).toBe(written);
  fixture.command("ROLLBACK");
  fixture.db.exec("ROLLBACK");
  expect(readRevision(fixture.db)).toBe(written);
});

it.skipIf(threadId !== 0)("rejects main-thread workloads before starting the bridge", () => {
  const anchor = harness.nativeDatabase();
  expect(
    () => new PostgresSyncConnection("postgres:///unused", "unused", anchor, "unused"),
  ).toThrow("PostgreSQL connections must run in a worker");
});

it.each([
  ["ok", "SELECT ?, 'literal-secret'", "binding-secret", "SELECT ?, ?"],
  ["error", "SELECT ?::text", "private\0text", "SELECT ?::text"],
] as const)("redacts statement observations on %s", (outcome, sql, binding, redacted) => {
  const fixture = transportFixture("normal");
  using observation = observeStatementEvents();
  const { events } = observation;
  const run = () => fixture.db.prepare(sql).get(binding);
  if (outcome === "error") {
    fixture.rejectQuery({
      name: "error",
      message: "invalid byte sequence",
      code: "22021",
    });
    expect(run).toThrow("invalid byte sequence");
  } else {
    run();
  }
  expect(events).toEqual([expect.objectContaining({ engine: "postgres", sql: redacted, outcome })]);
  expect(JSON.stringify(events)).not.toContain("private");
});

it("waits through a late notify until its own completion and preserves increasing ids", () => {
  const { db, sent, waits, normal } = transportFixture("spurious");
  expect(db.prepare("SELECT 7 AS value").get()).toEqual({ value: 7 });
  expect(waits).toEqual([
    { observed: 1, timeout: 50 },
    { observed: 1, timeout: 50 },
  ]);
  normal();
  expect(db.prepare("SELECT 7 AS value").get()).toEqual({ value: 7 });
  expect(sent.mock.calls.map(([request]) => request.id)).toEqual([2, 3]);
});

it.each(["mismatched", "missing", "timeout", "service-death"] as const)(
  "poisons %s requests and never sends another operation",
  (mode) => {
    const { db, sent, waits } = transportFixture(mode);
    const before = readToken(db.anchor, "entry");
    let failure: unknown;
    try {
      db.exec("SELECT 7");
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      message: "PostgreSQL connection lost; outcome unknown",
      code: "outcome-unknown",
    });
    expect(hasSqliteWorkerOutcomeUnknown(failure)).toBe(true);
    const after = readToken(db.anchor, "entry");
    expect(after).not.toBe(before);
    if (mode === "timeout") {
      expect(waits.reduce((sum, wait) => sum + (wait.timeout ?? 0), 0)).toBe(120_000);
      expect(waits.every((wait) => wait.timeout! <= 50)).toBe(true);
    }
    if (mode === "service-death") {
      expect(waits).toEqual([{ observed: 1, timeout: 50 }]);
    }
    const count = sent.mock.calls.length;
    expect(() => db.exec("SELECT 8")).toThrow("PostgreSQL connection lost; outcome unknown");
    expect(() => db.prepare("SELECT 9")).toThrow("PostgreSQL connection lost; outcome unknown");
    expect(sent).toHaveBeenCalledTimes(count);
    expect(readToken(db.anchor, "entry")).toBe(after);
  },
);

it.each([false, true])("settles anchored receipts (rollback=%s)", (rollback) => {
  const { db } = transactionFixture();
  const admission = harness.admission((_request, grant) => grant());
  const owner: SqliteWorkerOperationContext = { port: admission.port };
  const receipts: unknown[] = [];
  observeSqliteWorkerCommittedFacts(admission, ({ facts }) => receipts.push(facts));
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
});

it.each(["reserved", "worker"] as const)(
  "uses a locked read-committed transaction for %s writes",
  (mode) => {
    const { db, statements } = transactionFixture();
    const operation = () => {
      statements.push("body");
      return 7;
    };
    const admit = (stage: string) => statements.push(`admit:${stage}`);
    expect(
      mode === "reserved"
        ? reserved(db, operation, {})
        : worker({ database: db, databasePath: "", admit }, operation),
    ).toBe(7);
    expect(statements).toEqual(
      mode === "worker"
        ? ["admit:transaction", writeBegin, "body", "admit:commit", "COMMIT"]
        : [writeBegin, "body", "COMMIT"],
    );
  },
);

it("runs the commit authority guard and rolls back when it refuses", () => {
  const { db, statements } = transactionFixture();
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

it("invalidates staged authority after a lost COMMIT reply", () => {
  const fixture = transportFixture("normal");
  const phases: string[] = [];
  expect(() =>
    immediate(fixture.db, () => {
      stageSqliteTransactionState(fixture.db, {
        prepareCommit: () => phases.push("prepare"),
        commit: () => phases.push("commit"),
        rollback: () => phases.push("rollback"),
        invalidate: () => phases.push("invalidate"),
      });
      fixture.dropReplies();
    }),
  ).toThrow(expect.objectContaining({ code: "outcome-unknown" }));
  expect(phases).toEqual(["prepare", "invalidate"]);
  expect(fixture.db.isOpen).toBe(false);
});

it.each(["throw", "promise"])(
  "invalidates a committed write after its guard returns %s",
  (mode) => {
    const { db } = transactionFixture();
    const invalidate = vi.fn();
    const rollback = vi.fn();
    expect(() =>
      immediate(
        db,
        () => stageSqliteTransactionState(db, { commit: vi.fn(), invalidate, rollback }),
        {
          withCommit(commit) {
            commit();
            if (mode === "throw") {
              throw new Error("guard failed after COMMIT");
            }
            return Promise.resolve();
          },
        },
      ),
    ).toThrow(mode === "throw" ? "guard failed after COMMIT" : "synchronous");
    expect(invalidate).toHaveBeenCalledOnce();
    expect(rollback).not.toHaveBeenCalled();
    expect(db.isOpen).toBe(false);
  },
);

it.each([false, true])(
  "invalidates all staged state after failed rollback (nested=%s)",
  (nested) => {
    const { db } = transactionFixture();
    const execute = db.exec.bind(db);
    const failure = new Error("write refused");
    const phases: string[] = [];
    db.exec = (sql) => {
      if (sql.startsWith("ROLLBACK")) {
        throw new Error("rollback unavailable");
      }
      execute(sql);
    };
    const stage = (name: string) =>
      stageSqliteTransactionState(db, {
        commit: () => phases.push(`${name}:commit`),
        rollback: () => phases.push(`${name}:rollback`),
        invalidate: () => phases.push(`${name}:invalidate`),
      });
    expect(() =>
      immediate(db, () => {
        stage("outer");
        const fail = () => {
          stage("inner");
          throw failure;
        };
        return nested ? immediate(db, fail) : fail();
      }),
    ).toThrow(failure);
    expect(phases).toEqual(["inner:invalidate", "outer:invalidate"]);
    expect(db.isOpen).toBe(false);
  },
);

it("keeps a known rejected COMMIT distinct from an unknown outcome", () => {
  const fixture = transportFixture("normal");
  const rollback = vi.fn();
  const invalidate = vi.fn();
  expect(() =>
    immediate(fixture.db, () => {
      stageSqliteTransactionState(fixture.db, { commit: vi.fn(), rollback, invalidate });
      fixture.command("ROLLBACK");
    }),
  ).toThrow("rolled back instead of committing");
  expect(rollback).toHaveBeenCalledOnce();
  expect(invalidate).not.toHaveBeenCalled();
  expect(fixture.db.isOpen).toBe(true);
});

it("retires the connection even when an unknown-outcome invalidator throws", () => {
  const fixture = transportFixture("normal");
  const cleanup = new Error("authority invalidation failed");
  let failure: unknown;
  try {
    immediate(fixture.db, () => {
      stageSqliteTransactionState(fixture.db, {
        commit: vi.fn(),
        invalidate() {
          throw cleanup;
        },
      });
      fixture.dropReplies();
    });
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(AggregateError);
  expect(failure).toMatchObject({
    cause: expect.objectContaining({ code: "outcome-unknown" }),
    errors: [expect.objectContaining({ code: "outcome-unknown" }), cleanup],
  });
  expect(hasSqliteWorkerOutcomeUnknown(failure)).toBe(true);
  expect(fixture.db.isOpen).toBe(false);
});

it("prepares before asynchronous admission and commits only inside its guard", async () => {
  const { db, statements } = transactionFixture();
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

it("rolls a failed inner write back to its savepoint before the outer commit", () => {
  const { db, statements } = transactionFixture();
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
