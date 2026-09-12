import { createHash } from "node:crypto";
import { serialize } from "node:v8";
import { describe, expect, it, vi } from "vitest";
import {
  SQLITE_WORKER_MAX_RESULT_BYTES,
  SQLITE_WORKER_TRANSFER_FRAME_BYTES,
} from "./sqlite-worker-contract.js";
import {
  createSqliteWorkerTransferOwner,
  createSqliteWorkerTransferReceiver,
  type SqliteWorkerTransferFrame,
  type SqliteWorkerTransferValue,
} from "./sqlite-worker-transfer.js";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");

describe("bounded SQLite worker value transfers", () => {
  it.each(["one oversized row", "many rows"])(
    "preserves a complete %s result over 64 MiB",
    (shape) => {
      const value = `${"x".repeat((shape === "many rows" ? 1 : 65) * 1024 * 1024)}🌊`;
      const count = shape === "many rows" ? 65 : 1;
      const owner = createSqliteWorkerTransferOwner();
      const cleanup = vi.fn();
      const records = function* (): IterableIterator<SqliteWorkerTransferValue> {
        for (let index = 0; index < count; index += 1) {
          yield { kind: "row", value };
        }
      };
      const handle = owner.start(records(), { kinds: ["row"], cleanup });
      let bytes = 0;
      let values = 0;
      let sequence = 0;
      const receiver = createSqliteWorkerTransferReceiver(handle, ({ kind, value: restored }) => {
        expect(kind).toBe("row");
        expect(typeof restored).toBe("string");
        if (typeof restored === "string") {
          expect(restored.length).toBe(value.length);
          expect(digest(restored)).toBe(digest(value));
        }
        values += 1;
      });
      for (;;) {
        const frame = owner.next(handle.id);
        expect(frame.sequence).toBe(sequence++);
        expect(serialize(frame).byteLength).toBeLessThanOrEqual(SQLITE_WORKER_MAX_RESULT_BYTES);
        const counts = receiver.accept(frame);
        if (counts) {
          expect(counts).toEqual([["row", count]]);
          break;
        }
        if (frame.done) {
          throw new Error("Expected the receiver to complete at EOF");
        }
        expect(frame.bytes.byteLength).toBeLessThanOrEqual(SQLITE_WORKER_TRANSFER_FRAME_BYTES);
        expect(frame.bytes.buffer.byteLength).toBeLessThanOrEqual(
          SQLITE_WORKER_TRANSFER_FRAME_BYTES,
        );
        bytes += frame.bytes.byteLength;
      }
      owner.end(handle.id);
      expect(bytes).toBeGreaterThan(SQLITE_WORKER_MAX_RESULT_BYTES);
      expect(values).toBe(count);
      expect(cleanup).toHaveBeenCalledTimes(1);
    },
  );

  it("transfers already serialized bytes without serializing the record again", () => {
    const value = { unicode: "雪🌊", binary: new Uint8Array([0, 127, 255]), missing: undefined };
    const serialized = serialize(value);
    const owner = createSqliteWorkerTransferOwner();
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

  it.each(["id", "sequence", "kind", "offset", "length", "completion"] as const)(
    "rejects invalid %s framing without consuming a value or accepting continuation",
    (invalid) => {
      const bytes = serialize("complete row");
      const handle = { id: 1, kinds: ["row"] };
      const consume = vi.fn();
      const receiver = createSqliteWorkerTransferReceiver(handle, consume);
      const frame: SqliteWorkerTransferFrame = {
        id: 1,
        sequence: 0,
        done: false,
        kind: "row",
        recordBytes: bytes.byteLength,
        offset: 0,
        recordDone: true,
        bytes,
      };
      const invalidFrame = { ...frame };
      switch (invalid) {
        case "id":
          invalidFrame.id = 2;
          break;
        case "sequence":
          invalidFrame.sequence = 1;
          break;
        case "kind":
          invalidFrame.kind = "other";
          break;
        case "offset":
          invalidFrame.offset = 1;
          break;
        case "length":
          invalidFrame.recordBytes = bytes.byteLength - 1;
          break;
        case "completion":
          invalidFrame.recordDone = false;
          break;
      }
      expect(() => receiver.accept(invalidFrame)).toThrow(/SQLite read transfer/);
      expect(consume).not.toHaveBeenCalled();
      expect(() => receiver.accept({ ...frame, sequence: 1 })).toThrow("out of order");
    },
  );

  it.each(["missing", "duplicate", "incorrect", "partial"] as const)(
    "rejects a transfer ending with %s records",
    (invalid) => {
      const bytes = serialize("one row");
      const consume = vi.fn();
      const receiver = createSqliteWorkerTransferReceiver(
        { id: 1, kinds: ["row", "other"] },
        consume,
      );
      receiver.accept({
        id: 1,
        sequence: 0,
        done: false,
        kind: "row",
        recordBytes: bytes.byteLength,
        offset: 0,
        recordDone: invalid !== "partial",
        bytes: invalid === "partial" ? bytes.subarray(0, 1) : bytes,
      });
      expect(() =>
        receiver.accept({
          id: 1,
          sequence: 1,
          done: true,
          counts:
            invalid === "missing"
              ? [["row", 1]]
              : invalid === "duplicate"
                ? [
                    ["row", 1],
                    ["row", 1],
                  ]
                : [
                    ["row", 0],
                    ["other", 0],
                  ],
        }),
      ).toThrow("incomplete result");
      expect(consume).toHaveBeenCalledTimes(invalid === "partial" ? 0 : 1);
    },
  );

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
    const owner = createSqliteWorkerTransferOwner();
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
    const owner = createSqliteWorkerTransferOwner();
    owner.start([].values(), { kinds: ["row"], cleanup });
    expect(() => owner.cancel()).toThrow("native reader close failed");
    owner.close();
    owner.close();
    expect(cleanup).toHaveBeenCalledTimes(2);
  });
});
