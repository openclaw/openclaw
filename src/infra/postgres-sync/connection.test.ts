import { channel } from "node:diagnostics_channel";
import { MessageChannel, receiveMessageOnPort, threadId } from "node:worker_threads";
import { expect, it, vi } from "vitest";
import { withEngineStoreAdmission } from "../database-engine/admission-scope.js";
import { readSqliteDatabaseScopedWriteToken as readToken } from "../sqlite-database-admission.js";
import { readSqliteNativeMutationRevision as readRevision } from "../sqlite-schema-facts.js";
import { hasSqliteWorkerOutcomeUnknown } from "../sqlite-worker-contract.js";
import {
  deferSqliteWorkerCommitReceipt as deferReceipt,
  observeSqliteWorkerCommittedFacts,
  withSqliteWorkerOperationAdmission as withAdmission,
} from "../sqlite-worker-operation-admission.js";
import { PostgresSyncConnection } from "./connection.js";
import { usePostgresFixture } from "./fixture.test-support.js";
import type { BridgeReply, BridgeRequest, PostgresErrorData } from "./protocol.js";

const harness = usePostgresFixture();

function observeStatements() {
  const statements = channel("openclaw.database.statement");
  const events: unknown[] = [];
  const subscriber = (event: unknown) => events.push(event);
  statements.subscribe(subscriber);
  harness.cleanups.push(() => statements.unsubscribe(subscriber));
  return events;
}

function transportFixture(
  initialMode: "normal" | "spurious" | "mismatched" | "missing" | "timeout",
) {
  let mode = initialMode;
  let command: string | undefined;
  let queryError: PostgresErrorData | undefined;
  const { port1, port2 } = new MessageChannel();
  const control = new Int32Array(new SharedArrayBuffer(8));
  control.set([1, 1]);
  const terminate = vi.fn(async () => 0);
  // Exercise the connection over real ports; live tests cover worker startup and admission.
  const db = harness.connection();
  Object.assign(db, {
    port: port1,
    control,
    worker: { terminate, off: vi.fn() },
    requestId: 1,
  });
  const sent = vi.spyOn(port1, "postMessage");
  const waits: Array<{ observed: number | bigint; timeout: number | undefined }> = [];
  let now = 0;
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
      if (mode === "timeout") {
        now += timeout ?? 0;
        return "timed-out";
      }
    }
    const id = pending.id ?? 1;
    if (mode !== "missing" || !query) {
      const sql = query?.sql ?? "";
      const reply: BridgeReply =
        queryError && query
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
    Atomics.store(control, index, id);
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
    terminate,
    normal: () => (mode = "normal"),
    command: (value: string) => (command = value),
    rejectQuery: (error: PostgresErrorData) => (queryError = error),
  };
}

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

it.each(["read", "write", "rollback", "inner-rollback"] as const)(
  "publishes worker receipts only for committed mutations (%s)",
  (mode) => {
    const { db, command } = transportFixture("normal");
    const admission = harness.admission((_request, grant) => grant());
    const receipts: unknown[] = [];
    observeSqliteWorkerCommittedFacts(admission, ({ facts }) => receipts.push(facts));
    const operation = () => {
      command(mode === "read" ? "SELECT" : "INSERT");
      db.exec(mode === "read" ? "SELECT 1" : "INSERT INTO proof VALUES (7)");
      if (mode === "inner-rollback") {
        command("SAVEPOINT");
        expect(() =>
          db.runTransaction(() => {
            deferReceipt(db, { value: 7 });
            command("ROLLBACK");
            throw new Error("cancel inner receipt");
          }),
        ).toThrow("cancel inner receipt");
      }
      if (mode === "rollback") {
        command("ROLLBACK");
        throw new Error("cancel write");
      }
    };
    const run = () =>
      withAdmission({ port: admission.port, sourceReservations: true }, () =>
        db.runTransaction(operation, {
          withCommit(commit) {
            command("COMMIT");
            commit();
          },
        }),
      );
    if (mode === "rollback") {
      expect(run).toThrow("cancel write");
    } else {
      run();
    }
    admission.service();
    expect(receipts).toEqual(mode === "write" || mode === "inner-rollback" ? [{}] : []);
  },
);

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
  const events = observeStatements();
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
    { observed: 1, timeout: 120_000 },
    { observed: 1, timeout: 119_999 },
  ]);
  normal();
  expect(db.prepare("SELECT 7 AS value").get()).toEqual({ value: 7 });
  expect(sent.mock.calls.map(([request]) => request.id)).toEqual([2, 3]);
});

it.each(["mismatched", "missing", "timeout"] as const)(
  "poisons %s requests and never sends another operation",
  (mode) => {
    const { db, sent, terminate, waits } = transportFixture(mode);
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
    expect(terminate).toHaveBeenCalledOnce();
    if (mode === "timeout") {
      expect(waits).toHaveLength(1);
    }
    const count = sent.mock.calls.length;
    expect(() => db.exec("SELECT 8")).toThrow("PostgreSQL connection lost; outcome unknown");
    expect(() => db.prepare("SELECT 9")).toThrow("PostgreSQL connection lost; outcome unknown");
    expect(sent).toHaveBeenCalledTimes(count);
    expect(readToken(db.anchor, "entry")).toBe(after);
  },
);
