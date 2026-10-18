import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { createJsonFieldReceiver, JSON_FIELD_TRANSFER_BYTES } from "./json-field-transfer.js";
import type { SqliteReadOnlyOperationResult } from "./sqlite-readonly-operation-types.js";
import type { SqliteAuthProfileRows } from "./sqlite-readonly-worker-protocol.js";
import {
  SQLITE_WORKER_TRANSFER_FRAME_BYTES,
  createSqliteWorkerTransferReceiver,
  type SqliteWorkerTransferFrame,
} from "./sqlite-worker-transfer.js";

type SqliteAuthTransferRequest = { type: "next" | "end"; transferId: number };

/** JSON IPC carries only one bounded byte frame; aggregate records retain the transfer contract. */
export function encodeSqliteAuthTransferFrame(frame: SqliteWorkerTransferFrame) {
  // Encoding is synchronous; only the string escapes, so the owned frame needs no copy.
  return frame.done
    ? frame
    : {
        ...frame,
        bytes: Buffer.from(
          frame.bytes.buffer,
          frame.bytes.byteOffset,
          frame.bytes.byteLength,
        ).toString("base64"),
      };
}

function decodeFrame(value: unknown, label: string): SqliteWorkerTransferFrame {
  if (
    !isRecord(value) ||
    typeof value.id !== "number" ||
    !Number.isSafeInteger(value.id) ||
    typeof value.sequence !== "number" ||
    !Number.isSafeInteger(value.sequence)
  ) {
    throw new Error(`Invalid ${label} transfer frame`);
  }
  const { id, sequence } = value;
  if (value.done === true && Array.isArray(value.counts)) {
    const counts: Array<[string, number]> = [];
    for (const entry of value.counts) {
      if (
        !Array.isArray(entry) ||
        entry.length !== 2 ||
        typeof entry[0] !== "string" ||
        typeof entry[1] !== "number" ||
        !Number.isSafeInteger(entry[1]) ||
        entry[1] < 0
      ) {
        throw new Error(`Invalid ${label} transfer counts`);
      }
      counts.push([entry[0], entry[1]]);
    }
    return { id, sequence, done: true, counts };
  }
  if (
    value.done !== false ||
    typeof value.kind !== "string" ||
    typeof value.recordBytes !== "number" ||
    typeof value.offset !== "number" ||
    typeof value.recordDone !== "boolean" ||
    typeof value.bytes !== "string" ||
    value.bytes.length > 4 * Math.ceil(SQLITE_WORKER_TRANSFER_FRAME_BYTES / 3)
  ) {
    throw new Error(`Invalid ${label} transfer bytes`);
  }
  const bytes = Buffer.from(value.bytes, "base64");
  if (bytes.toString("base64") !== value.bytes) {
    throw new Error(`Invalid ${label} transfer encoding`);
  }
  return {
    id,
    sequence,
    done: false,
    kind: value.kind,
    recordBytes: value.recordBytes,
    offset: value.offset,
    recordDone: value.recordDone,
    bytes,
  };
}

function createSqliteReadOnlyTransferReceiver<T>(options: {
  kinds: string[];
  label: string;
  maxRecordBytes?: number;
  acceptRecord: (kind: string, value: unknown) => void;
  readResult: () => T;
}) {
  let receiver: ReturnType<typeof createSqliteWorkerTransferReceiver> | undefined;
  let transferId: number | undefined;
  let ending = false;
  let completed = false;
  return {
    accept(value: unknown): { request: SqliteAuthTransferRequest } | { value: T } {
      if (!isRecord(value) || completed) {
        throw new Error(`Invalid ${options.label} transfer response`);
      }
      if (value.type === "start" && !receiver) {
        const handle = value.handle;
        if (
          !isRecord(handle) ||
          typeof handle.id !== "number" ||
          !Number.isSafeInteger(handle.id) ||
          handle.id < 1 ||
          !Array.isArray(handle.kinds) ||
          handle.kinds.length !== options.kinds.length ||
          handle.kinds.some((kind, index) => kind !== options.kinds[index])
        ) {
          throw new Error(`Invalid ${options.label} transfer handle`);
        }
        transferId = handle.id;
        receiver = createSqliteWorkerTransferReceiver(
          { id: transferId, kinds: options.kinds },
          ({ kind, value: record }) => options.acceptRecord(kind, record),
        );
        return { request: { type: "next", transferId } };
      }
      if (!receiver || transferId === undefined) {
        throw new Error(
          `${options.label.charAt(0).toUpperCase()}${options.label.slice(1)} transfer has not started`,
        );
      }
      if (value.type === "frame" && !ending) {
        const frame = decodeFrame(value.frame, options.label);
        if (!frame.done && options.maxRecordBytes && frame.recordBytes > options.maxRecordBytes) {
          throw new Error(`${options.label} transfer record exceeds its bound`);
        }
        const counts = receiver.accept(frame);
        if (counts) {
          if (counts.length !== options.kinds.length || counts.some(([, count]) => count < 1)) {
            throw new Error(`Incomplete ${options.label} transfer result`);
          }
          ending = true;
        }
        return { request: { type: ending ? "end" : "next", transferId } };
      }
      if (value.type === "complete" && ending) {
        completed = true;
        return { value: options.readResult() };
      }
      throw new Error(
        `${options.label.charAt(0).toUpperCase()}${options.label.slice(1)} transfer response is out of order`,
      );
    },
  };
}

export function createSqliteAuthTransferReceiver() {
  const receiver = createJsonFieldReceiver();
  return createSqliteReadOnlyTransferReceiver<SqliteAuthProfileRows>({
    kinds: ["fields"],
    label: "auth profile",
    maxRecordBytes: JSON_FIELD_TRANSFER_BYTES,
    acceptRecord(_kind, batch) {
      if (!Array.isArray(batch)) {
        throw new Error("Invalid auth profile field batch");
      }
      for (const field of batch) {
        receiver.accept(field);
      }
    },
    readResult() {
      const rows = receiver.finish();
      if (
        !isRecord(rows) ||
        !("store" in rows) ||
        !("state" in rows) ||
        typeof rows.cacheable !== "boolean"
      ) {
        throw new Error("Invalid auth profile transfer rows");
      }
      return { store: rows.store, state: rows.state, cacheable: rows.cacheable };
    },
  });
}

export function createSqliteOperationTransferReceiver(operation: string) {
  let result: SqliteReadOnlyOperationResult | undefined;
  return createSqliteReadOnlyTransferReceiver<SqliteReadOnlyOperationResult>({
    kinds: ["result"],
    label: "SQLite operation",
    acceptRecord(_kind, record) {
      if (result || !isRecord(record) || record.operation !== operation || !("value" in record)) {
        throw new Error("SQLite read-only worker returned a different or duplicate operation");
      }
      result = { operation, value: record.value };
    },
    readResult() {
      if (!result) {
        throw new Error("SQLite read-only worker returned no operation");
      }
      return result;
    },
  });
}
