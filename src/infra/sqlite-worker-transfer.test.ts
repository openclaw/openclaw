import { serialize } from "node:v8";
import { beforeEach, expect, it, vi } from "vitest";
import { SQLITE_WORKER_MAX_RESULT_BYTES } from "./sqlite-worker-contract.js";
import {
  SQLITE_WORKER_TRANSFER_FRAME_BYTES,
  createSqliteWorkerTransferOwner,
  createSqliteWorkerTransferReceiver,
  type SqliteWorkerTransferFrame,
} from "./sqlite-worker-transfer.js";

const rowHeader = {
  id: 1,
  sequence: 0,
  done: false as const,
  kind: "row",
  offset: 0,
  recordDone: true,
};
function rowFrame(value: string): Extract<SqliteWorkerTransferFrame, { done: false }> {
  const bytes = serialize(value);
  return { ...rowHeader, recordBytes: bytes.byteLength, bytes };
}
let owner: ReturnType<typeof createSqliteWorkerTransferOwner>;
beforeEach(() => {
  owner = createSqliteWorkerTransferOwner();
});

it("preserves a complete oversized row over 64 MiB", () => {
  const value = `${"x".repeat(65 * 1024 * 1024)}🌊`;
  const cleanup = vi.fn();
  const handle = owner.start([{ kind: "row", value }].values(), { kinds: ["row"], cleanup });
  let bytes = 0;
  const values: Array<{ kind: string; value: unknown }> = [];
  let sequence = 0;
  const receiver = createSqliteWorkerTransferReceiver(handle, (record) => {
    values.push(record);
  });
  for (;;) {
    const frame = owner.next(handle.id);
    expect(frame.sequence).toBe(sequence++);
    expect(serialize(frame).byteLength).toBeLessThanOrEqual(SQLITE_WORKER_MAX_RESULT_BYTES);
    const counts = receiver.accept(frame);
    if (counts) {
      expect(counts).toEqual([["row", 1]]);
      break;
    }
    if (frame.done) {
      throw new Error("Expected the receiver to complete at EOF");
    }
    expect(frame.bytes.byteLength).toBeLessThanOrEqual(SQLITE_WORKER_TRANSFER_FRAME_BYTES);
    expect(frame.bytes.buffer.byteLength).toBeLessThanOrEqual(SQLITE_WORKER_TRANSFER_FRAME_BYTES);
    bytes += frame.bytes.byteLength;
  }
  owner.end(handle.id);
  expect(bytes).toBeGreaterThan(SQLITE_WORKER_MAX_RESULT_BYTES);
  expect(values).toEqual([{ kind: "row", value }]);
  expect(cleanup).toHaveBeenCalledTimes(1);
});

it("transfers already serialized bytes without serializing the record again", () => {
  const value = { unicode: "雪🌊", binary: new Uint8Array([0, 127, 255]), missing: undefined };
  const serialized = serialize(value);
  const handle = owner.start([{ kind: "result", serialized }].values(), { kinds: ["result"] });
  const consume = vi.fn();
  const receiver = createSqliteWorkerTransferReceiver(handle, consume);
  const frame = owner.next(handle.id);
  expect(frame).toMatchObject({
    done: false,
    recordBytes: serialized.byteLength,
    bytes: new Uint8Array(serialized),
  });
  expect(receiver.accept(frame)).toBeUndefined();
  expect(consume).toHaveBeenCalledExactlyOnceWith({ kind: "result", value });
  const end = owner.next(handle.id);
  expect(receiver.accept(end)).toEqual([["result", 1]]);
  owner.end(handle.id);
  expect(() => receiver.accept(end)).toThrow("out of order");
  expect(consume).toHaveBeenCalledTimes(1);
});

it.each([
  ["kind", { kind: "invalid" }],
  ["offset", { offset: 1 }],
  ["completion", { recordDone: false }],
  ["duplicate counts", null],
] as const)("rejects invalid %s frames", (_invalid, patch) => {
  const handle = { id: 1, kinds: ["row", "other"] };
  const consume = vi.fn();
  const receiver = createSqliteWorkerTransferReceiver(handle, consume);
  const frame = rowFrame("complete row");
  const duplicate = patch === null;
  if (duplicate) {
    receiver.accept(frame);
  }
  const invalidFrame: SqliteWorkerTransferFrame = duplicate
    ? {
        id: 1,
        sequence: 1,
        done: true,
        counts: [
          ["row", 1],
          ["row", 1],
        ],
      }
    : { ...frame, ...patch };
  expect(() => receiver.accept(invalidFrame)).toThrow(
    duplicate ? "incomplete result" : /SQLite read transfer/,
  );
  expect(consume).toHaveBeenCalledTimes(duplicate ? 1 : 0);
  expect(() => receiver.accept({ ...frame, sequence: 1 })).toThrow("out of order");
});

it("releases an abandoned iterator before accepting another transfer", () => {
  const released = vi.fn();
  const cleanup = vi.fn();
  const rows = function* () {
    try {
      yield { kind: "row", value: "first" };
      yield { kind: "row", value: "second" };
    } finally {
      released();
    }
  };
  const first = owner.start(rows(), { kinds: ["row"], cleanup });
  const receiver = createSqliteWorkerTransferReceiver(first, () => {
    throw new Error("consumer stopped");
  });
  const frame = owner.next(first.id);
  expect(frame).toMatchObject({ done: false, recordDone: true });
  expect(() => receiver.accept(frame)).toThrow("consumer stopped");
  expect(() => owner.end(first.id)).toThrow("before its complete result");
  owner.cancel();
  owner.cancel();
  expect(released).toHaveBeenCalledTimes(1);
  expect(cleanup).toHaveBeenCalledTimes(1);
  const second = owner.start([].values(), { kinds: ["row"] });
  expect(owner.next(second.id)).toMatchObject({ done: true, counts: [["row", 0]] });
  owner.end(second.id);
});

it("retains failed cleanup for the actor close boundary", () => {
  const cleanup = vi.fn().mockImplementationOnce(() => {
    throw new Error("native reader close failed");
  });
  owner.start([].values(), { kinds: ["row"], cleanup });
  expect(() => owner.cancel()).toThrow("native reader close failed");
  owner.close();
  owner.close();
  expect(cleanup).toHaveBeenCalledTimes(2);
});
