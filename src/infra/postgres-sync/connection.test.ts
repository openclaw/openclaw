import { DatabaseSync } from "node:sqlite";
import { MessageChannel, receiveMessageOnPort } from "node:worker_threads";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hasSqliteWorkerOutcomeUnknown } from "../sqlite-worker-contract.js";
import { PostgresSyncConnection } from "./connection.js";
import type { BridgeReply, BridgeRequest } from "./protocol.js";

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
  const { port1, port2 } = new MessageChannel();
  const control = new Int32Array(new SharedArrayBuffer(8));
  control.set([1, 1]);
  const anchor = new DatabaseSync(":memory:");
  const terminate = vi.fn(async () => 0);
  // Exercise the connection over real ports; live tests cover worker startup and admission.
  const db = Object.create(PostgresSyncConnection.prototype) as PostgresSyncConnection;
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
      const reply: BridgeReply = {
        id: mode === "mismatched" && pending.operation === "query" ? id + 1 : id,
        result: { rows: [{ value: 7 }], rowCount: 1, fields: [{ name: "value", dataTypeID: 23 }] },
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
  return { db, sent, waits, terminate, normal: () => (mode = "normal") };
}

describe("PostgreSQL bridge request correlation", () => {
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
      expect(terminate).toHaveBeenCalledOnce();
      const count = sent.mock.calls.length;
      expect(() => db.exec("SELECT 8")).toThrow("PostgreSQL connection lost; outcome unknown");
      expect(() => db.prepare("SELECT 9")).toThrow("PostgreSQL connection lost; outcome unknown");
      expect(sent).toHaveBeenCalledTimes(count);
    },
  );

  it("poisons an expired request deadline without extending it after a wakeup", () => {
    const { db, sent, waits } = transportFixture("timeout");
    expect(() => db.exec("SELECT 7")).toThrow("PostgreSQL connection lost; outcome unknown");
    expect(waits).toHaveLength(1);
    const count = sent.mock.calls.length;
    expect(() => db.exec("SELECT 8")).toThrow("PostgreSQL connection lost; outcome unknown");
    expect(sent).toHaveBeenCalledTimes(count);
  });
});
