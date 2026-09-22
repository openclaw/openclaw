import { deserialize, serialize } from "node:v8";
import {
  SQLITE_WORKER_TRANSFER_FRAME_BYTES,
  type SqliteWorkerTransferHandle,
} from "./sqlite-worker-contract.js";
export type SqliteWorkerTransferValue = { kind: string; value: unknown };
export type SqliteWorkerTransferInput =
  | SqliteWorkerTransferValue
  /** Already serialized bytes remain owned by the producer and immutable until release. */
  | { kind: string; serialized: Uint8Array };
export type SqliteWorkerTransferCounts = Array<[string, number]>;
export type SqliteWorkerTransferFrame = { id: number; sequence: number } & (
  | { done: true; counts: SqliteWorkerTransferCounts }
  | {
      done: false;
      kind: string;
      recordBytes: number;
      offset: number;
      recordDone: boolean;
      bytes: Uint8Array;
    }
);

type Transfer = {
  id: number;
  iterator: Iterator<SqliteWorkerTransferInput>;
  cleanup?: () => void;
  iteratorClosed: boolean;
  cleaned: boolean;
  counts: Map<string, number>;
  sequence: number;
  finished: boolean;
  record?: { kind: string; bytes: Uint8Array; offset: number };
};

/** One owned result cursor; callers supply records and any associated cleanup. */
export function createSqliteWorkerTransferOwner() {
  let nextId = 0;
  let current: Transfer | undefined;

  const cleanup = (transfer: Transfer) => {
    const errors: unknown[] = [];
    if (!transfer.iteratorClosed) {
      try {
        transfer.iterator.return?.();
        transfer.iteratorClosed = true;
      } catch (error) {
        errors.push(error);
      }
    }
    if (!transfer.cleaned) {
      try {
        transfer.cleanup?.();
        transfer.cleaned = true;
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length === 1) {
      throw errors[0];
    }
    if (errors.length) {
      throw new AggregateError(errors, "SQLite read transfer cleanup failed", { cause: errors[0] });
    }
  };
  const cancel = () => {
    if (current) {
      cleanup(current);
      current = undefined;
    }
  };
  const requireTransfer = (id: number) => {
    if (!current || current.id !== id) {
      throw new Error("SQLite read transfer is no longer active");
    }
    return current;
  };

  return {
    start(
      iterator: Iterator<SqliteWorkerTransferInput>,
      options: { kinds: string[]; cleanup?: () => void },
    ): SqliteWorkerTransferHandle {
      if (current) {
        throw new Error("The preceding SQLite read transfer was not released");
      }
      current = {
        id: ++nextId,
        iterator,
        cleanup: options.cleanup,
        iteratorClosed: false,
        cleaned: false,
        counts: new Map(options.kinds.map((kind) => [kind, 0])),
        sequence: 0,
        finished: false,
      };
      return { id: current.id, kinds: [...current.counts.keys()] };
    },
    next(id: number): SqliteWorkerTransferFrame {
      const transfer = requireTransfer(id);
      if (transfer.finished) {
        throw new Error("SQLite read transfer has already reached its end");
      }
      if (transfer.record && transfer.record.offset === transfer.record.bytes.byteLength) {
        transfer.record = undefined;
      }
      if (!transfer.record) {
        const next = transfer.iterator.next();
        if (next.done) {
          cleanup(transfer);
          transfer.finished = true;
          return { id, sequence: transfer.sequence++, done: true, counts: [...transfer.counts] };
        }
        const { kind } = next.value;
        const count = transfer.counts.get(kind);
        if (count === undefined) {
          throw new Error("SQLite read transfer returned an unexpected record kind");
        }
        transfer.record = {
          kind,
          bytes: "serialized" in next.value ? next.value.serialized : serialize(next.value.value),
          offset: 0,
        };
        transfer.counts.set(kind, count + 1);
      }
      const record = transfer.record;
      const offset = record.offset;
      const end = Math.min(record.bytes.byteLength, offset + SQLITE_WORKER_TRANSFER_FRAME_BYTES);
      record.offset = end;
      return {
        id,
        sequence: transfer.sequence++,
        done: false,
        kind: record.kind,
        recordBytes: record.bytes.byteLength,
        offset,
        recordDone: end === record.bytes.byteLength,
        // Bun serialization includes the backing buffer, so each frame must own only its bytes.
        bytes: new Uint8Array(record.bytes.subarray(offset, end)),
      };
    },
    end(id: number): void {
      const transfer = requireTransfer(id);
      if (!transfer.finished) {
        throw new Error("SQLite read transfer ended before its complete result");
      }
      cancel();
    },
    cancel,
    close: cancel,
  };
}

/** Reassembles one transfer; its caller owns transport completion and cancellation. */
export function createSqliteWorkerTransferReceiver(
  handle: SqliteWorkerTransferHandle,
  consume: (record: SqliteWorkerTransferValue) => void,
): { accept(frame: SqliteWorkerTransferFrame): SqliteWorkerTransferCounts | undefined } {
  const counts = new Map(handle.kinds.map((kind) => [kind, 0]));
  let sequence = 0;
  let finished = false;
  let record: { kind: string; bytes: Uint8Array; offset: number } | undefined;
  return {
    accept(frame) {
      try {
        if (finished || frame.id !== handle.id || frame.sequence !== sequence++) {
          throw new Error("SQLite read transfer frame is out of order");
        }
        if (frame.done) {
          if (
            record ||
            frame.counts.length !== counts.size ||
            frame.counts.some(([kind, count]) => counts.get(kind) !== count) ||
            new Set(frame.counts.map(([kind]) => kind)).size !== counts.size
          ) {
            throw new Error("SQLite read transfer ended with an incomplete result");
          }
          finished = true;
          return frame.counts;
        }
        const count = counts.get(frame.kind);
        if (
          count === undefined ||
          !Number.isSafeInteger(frame.recordBytes) ||
          frame.recordBytes < 1 ||
          !Number.isSafeInteger(frame.offset) ||
          frame.offset < 0 ||
          frame.bytes.byteLength < 1 ||
          frame.bytes.byteLength > SQLITE_WORKER_TRANSFER_FRAME_BYTES
        ) {
          throw new Error("SQLite read transfer returned an invalid frame");
        }
        if (!record) {
          if (frame.offset !== 0) {
            throw new Error("SQLite read transfer omitted the start of a record");
          }
          record = { kind: frame.kind, bytes: new Uint8Array(frame.recordBytes), offset: 0 };
        }
        const end = frame.offset + frame.bytes.byteLength;
        if (
          record.kind !== frame.kind ||
          record.bytes.byteLength !== frame.recordBytes ||
          record.offset !== frame.offset ||
          end > frame.recordBytes ||
          frame.recordDone !== (end === frame.recordBytes)
        ) {
          throw new Error("SQLite read transfer returned a discontinuous record");
        }
        record.bytes.set(frame.bytes, frame.offset);
        record.offset = end;
        if (frame.recordDone) {
          const value: unknown = deserialize(record.bytes);
          const kind = record.kind;
          record = undefined;
          consume({ kind, value });
          counts.set(kind, count + 1);
        }
        return undefined;
      } catch (error) {
        record = undefined;
        finished = true;
        throw error;
      }
    },
  };
}
