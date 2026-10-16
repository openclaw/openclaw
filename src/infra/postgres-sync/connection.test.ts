import { channel } from "node:diagnostics_channel";
import { DatabaseSync } from "node:sqlite";
import { MessageChannel, receiveMessageOnPort, threadId } from "node:worker_threads";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withEngineStoreAdmission } from "../database-engine/admission-scope.js";
import { readSqliteDatabaseScopedWriteToken } from "../sqlite-database-admission.js";
import { hasSqliteWorkerOutcomeUnknown } from "../sqlite-worker-contract.js";
import { PostgresSyncConnection } from "./connection.js";
import type { BridgeReply, BridgeRequest, PostgresErrorData } from "./protocol.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) {
    cleanup();
  }
  vi.restoreAllMocks();
});

function transportFixture(
  initialMode: "normal" | "spurious" | "mismatched" | "missing" | "timeout",
) {
  let mode = initialMode;
  let command: string | undefined;
  let queryError: PostgresErrorData | undefined;
  const { port1, port2 } = new MessageChannel();
  const control = new Int32Array(new SharedArrayBuffer(8));
  control.set([1, 1]);
  const anchor = new DatabaseSync(":memory:");
  const terminate = vi.fn(async () => 0);
  // Exercise the connection over real ports; live tests cover worker startup and admission.
  const db = Object.create(PostgresSyncConnection.prototype) as PostgresSyncConnection;
  Object.defineProperty(db, Symbol.for("openclaw.postgres-sync-connection"), { value: true });
  Object.assign(db, {
    port: port1,
    control,
    worker: { terminate },
    requestId: 1,
    anchor,
    isOpen: true,
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
    if (pending.operation === "query") {
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
    if (mode !== "missing" || pending.operation !== "query") {
      const reply: BridgeReply =
        queryError && pending.operation === "query"
          ? {
              id,
              error: queryError,
            }
          : {
              id: mode === "mismatched" && pending.operation === "query" ? id + 1 : id,
              result: {
                command,
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
  cleanups.push(() => {
    mode = "normal";
    try {
      db.close();
    } catch {
      // The pre-fix implementation can also fail while retiring a poisoned fixture.
    }
    port1.close();
    port2.close();
    anchor.close();
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

describe("PostgreSQL bridge request correlation", () => {
  it("reports an invalid DSN promptly with connection repair guidance", () => {
    const anchor = new DatabaseSync(":memory:");
    const started = performance.now();
    try {
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
    } finally {
      anchor.close();
    }
  });

  it.each(["COMMIT", "ROLLBACK"])(
    "changes the anchor token for COMMIT, retaining it for ROLLBACK (%s)",
    (command) => {
      const fixture = transportFixture("normal");
      fixture.command(command);
      fixture.db.isTransaction = true;
      const before = readSqliteDatabaseScopedWriteToken(fixture.db.anchor, "entry");
      fixture.db.exec(command);
      const after = readSqliteDatabaseScopedWriteToken(fixture.db.anchor, "entry");
      expect(after === before).toBe(command === "ROLLBACK");
    },
  );

  it("retains the anchor token when PostgreSQL rolls back a requested commit", () => {
    const fixture = transportFixture("normal");
    fixture.command("ROLLBACK");
    fixture.db.isTransaction = true;
    const before = readSqliteDatabaseScopedWriteToken(fixture.db.anchor, "entry");
    expect(() => fixture.db.exec("COMMIT")).toThrow("rolled back instead of committing");
    expect(readSqliteDatabaseScopedWriteToken(fixture.db.anchor, "entry")).toBe(before);
  });

  it.skipIf(threadId !== 0)(
    "rejects opening a workload connection on the main thread before starting its bridge",
    () => {
      expect(threadId).toBe(0);
      const anchor = new DatabaseSync(":memory:");
      try {
        expect(
          () =>
            new PostgresSyncConnection("postgres:///unused", "unused", anchor, "unused", {
              lockTimeoutMs: 60_000,
              statementTimeoutMs: 90_000,
            }),
        ).toThrow("only synchronous admission and migrations may run on the main thread");
      } finally {
        anchor.close();
      }
    },
  );

  it("publishes executed PostgreSQL statements without literal or binding values", () => {
    const { db } = transportFixture("normal");
    const statements = channel("openclaw.database.statement");
    const events: unknown[] = [];
    const subscriber = (event: unknown) => events.push(event);
    statements.subscribe(subscriber);
    try {
      db.prepare("SELECT ? AS value, 'literal-secret' AS text").get("binding-secret");
      expect(events).toEqual([
        expect.objectContaining({
          engine: "postgres",
          sql: "SELECT ? AS value, ? AS text",
          outcome: "ok",
        }),
      ]);
    } finally {
      statements.unsubscribe(subscriber);
    }
  });

  it("observes a PostgreSQL invalid-text error without publishing the NUL-containing binding", () => {
    const fixture = transportFixture("normal");
    fixture.rejectQuery({
      name: "error",
      message: 'invalid byte sequence for encoding "UTF8": 0x00',
      code: "22021",
    });
    const statements = channel("openclaw.database.statement");
    const events: unknown[] = [];
    const subscriber = (event: unknown) => events.push(event);
    statements.subscribe(subscriber);
    try {
      expect(() => fixture.db.prepare("SELECT ?::text").get("private\0text")).toThrow(
        "invalid byte sequence",
      );
      expect(events).toEqual([
        expect.objectContaining({ engine: "postgres", sql: "SELECT ?::text", outcome: "error" }),
      ]);
      expect(JSON.stringify(events)).not.toContain("private");
    } finally {
      statements.unsubscribe(subscriber);
    }
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

  it.each(["mismatched", "missing"] as const)(
    "poisons a connection with a %s reply and never sends another operation",
    (mode) => {
      const { db, sent, terminate } = transportFixture(mode);
      const before = readSqliteDatabaseScopedWriteToken(db.anchor, "entry");
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
      const after = readSqliteDatabaseScopedWriteToken(db.anchor, "entry");
      expect(after).not.toBe(before);
      expect(terminate).toHaveBeenCalledOnce();
      const count = sent.mock.calls.length;
      expect(() => db.exec("SELECT 8")).toThrow("PostgreSQL connection lost; outcome unknown");
      expect(() => db.prepare("SELECT 9")).toThrow("PostgreSQL connection lost; outcome unknown");
      expect(sent).toHaveBeenCalledTimes(count);
      expect(readSqliteDatabaseScopedWriteToken(db.anchor, "entry")).toBe(after);
    },
  );

  it("retains the anchor token when a lost mid-transaction statement definitely rolls back", () => {
    const { db } = transportFixture("missing");
    db.isTransaction = true;
    const before = readSqliteDatabaseScopedWriteToken(db.anchor, "entry");
    expect(() => db.exec("UPDATE entries SET value = 8")).toThrow(
      "PostgreSQL connection lost; transaction rolled back",
    );
    expect(readSqliteDatabaseScopedWriteToken(db.anchor, "entry")).toBe(before);
  });

  it("poisons an expired request deadline without extending it after a wakeup", () => {
    const { db, sent, waits } = transportFixture("timeout");
    expect(() => db.exec("SELECT 7")).toThrow("PostgreSQL connection lost; outcome unknown");
    expect(waits).toHaveLength(1);
    const count = sent.mock.calls.length;
    expect(() => db.exec("SELECT 8")).toThrow("PostgreSQL connection lost; outcome unknown");
    expect(sent).toHaveBeenCalledTimes(count);
  });
});
