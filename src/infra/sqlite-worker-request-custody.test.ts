import { serialize } from "node:v8";
import { expect, it, vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import { failSqliteWorkerSlot, receiveSqliteWorkerReply } from "./sqlite-worker-broker-reply.js";
import type { Job } from "./sqlite-worker-broker.types.js";
import {
  readSqliteWorkerRequestCustody,
  SqliteWorkerSlotCustody,
} from "./sqlite-worker-request-custody.js";

it("distinguishes queued cancellation, accepted work, and permanently retired generations", () => {
  const slot = new SqliteWorkerSlotCustody();
  const queued = slot.createRequest();
  queued.cancel();
  expect(() => queued.activate()).toThrow("already used");
  expect(readSqliteWorkerRequestCustody(queued.descriptor)).toBe(false);

  const accepted = slot.createRequest();
  accepted.activate();
  accepted.accept();
  accepted.cancel();
  expect(readSqliteWorkerRequestCustody(accepted.descriptor)).toBe(true);
  accepted.retire();
  expect(readSqliteWorkerRequestCustody(accepted.descriptor)).toBe(false);
  expect(accepted.dispatched).toBe(true);
  expect(() => accepted.activate()).toThrow("already used");

  const successor = slot.createRequest();
  successor.activate();
  expect(readSqliteWorkerRequestCustody(successor.descriptor)).toBe(true);
  slot.retire();
  const replacement = new SqliteWorkerSlotCustody().createRequest();
  replacement.activate();
  expect(readSqliteWorkerRequestCustody(structuredClone(successor.descriptor))).toBe(false);
  expect(readSqliteWorkerRequestCustody(replacement.descriptor)).toBe(true);
});

function currentJob(slot: SqliteWorkerSlotCustody): Job {
  const custody = slot.createRequest();
  custody.activate();
  custody.accept();
  return {
    custody,
    observation: { started() {}, completed() {} },
    request: { type: "execute", id: 1, actor: 1, input: new Uint8Array() },
    bytes: 0,
    result: new Promise(() => {}),
    resolve: vi.fn(),
    reject: vi.fn(),
    detach: vi.fn(),
  };
}

it("revokes before failure observers and retains accepted work until native retirement", async () => {
  const custody = new SqliteWorkerSlotCustody();
  const current = currentJob(custody);
  const retirement = createDeferredCore();
  const observe = vi.fn(() => {
    expect(readSqliteWorkerRequestCustody(current.custody.descriptor)).toBe(false);
    expect(current.custody.dispatched).toBe(true);
  });
  const finish = vi.fn();
  failSqliteWorkerSlot(
    {
      custody,
      current,
      queue: [],
      actors: new Set([{ backendClosed: false, nativeLostObservers: new Set([observe]) }]),
    },
    new Error("synthetic worker failure"),
    { retire: () => retirement.promise, finish },
  );
  expect(observe).toHaveBeenCalledOnce();
  expect(finish).not.toHaveBeenCalled();
  retirement.resolve();
  await retirement.promise;
  expect(finish).toHaveBeenCalledWith(current, expect.any(Error), undefined, {
    kind: "unknown",
    error: expect.any(Error),
    nativeStopped: true,
  });
});

it("retires a completed job before its successor can reuse the same request ID", () => {
  const custody = new SqliteWorkerSlotCustody();
  const current = currentJob(custody);
  const slot = { current, actors: new Set<never>(), worker: { postMessage() {} } };
  const finish = vi.fn(() => {
    expect(readSqliteWorkerRequestCustody(current.custody.descriptor)).toBe(false);
  });
  receiveSqliteWorkerReply(
    slot,
    { id: 1, ok: true, value: serialize("committed") },
    {
      fail: vi.fn(),
      finish,
      dispatch() {
        slot.current = currentJob(custody);
      },
    },
  );
  expect(finish).toHaveBeenCalledWith(current, undefined, "committed");
  expect(readSqliteWorkerRequestCustody(slot.current!.custody.descriptor)).toBe(true);
  expect(readSqliteWorkerRequestCustody(structuredClone(current.custody.descriptor))).toBe(false);
});
