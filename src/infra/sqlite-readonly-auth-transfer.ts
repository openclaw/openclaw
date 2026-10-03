import { isRecord } from "@openclaw/normalization-core/record-coerce";
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
  readHandle?: (handle: Record<string, unknown>) => void;
  readResult: (records: Map<string, unknown>) => T;
}) {
  let receiver: ReturnType<typeof createSqliteWorkerTransferReceiver> | undefined;
  let transferId: number | undefined;
  let ending = false;
  let completed = false;
  const records = new Map<string, unknown>();
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
        options.readHandle?.(handle);
        receiver = createSqliteWorkerTransferReceiver(
          { id: transferId, kinds: options.kinds },
          ({ kind, value: record }) => {
            if (records.has(kind)) {
              throw new Error(`Duplicate ${options.label} transfer record`);
            }
            records.set(kind, record);
          },
        );
        return { request: { type: "next", transferId } };
      }
      if (!receiver || transferId === undefined) {
        throw new Error(
          `${options.label.charAt(0).toUpperCase()}${options.label.slice(1)} transfer has not started`,
        );
      }
      if (value.type === "frame" && !ending) {
        const counts = receiver.accept(decodeFrame(value.frame, options.label));
        if (counts) {
          if (
            records.size !== options.kinds.length ||
            options.kinds.some((kind) => !records.has(kind))
          ) {
            throw new Error(`Incomplete ${options.label} transfer result`);
          }
          ending = true;
        }
        return { request: { type: ending ? "end" : "next", transferId } };
      }
      if (value.type === "complete" && ending) {
        completed = true;
        const result = options.readResult(records);
        records.clear();
        return { value: result };
      }
      throw new Error(
        `${options.label.charAt(0).toUpperCase()}${options.label.slice(1)} transfer response is out of order`,
      );
    },
  };
}

export function createSqliteAuthTransferReceiver() {
  let cacheable = false;
  return createSqliteReadOnlyTransferReceiver<SqliteAuthProfileRows>({
    kinds: ["store", "state"],
    label: "auth profile",
    readHandle(handle) {
      if (typeof handle.cacheable !== "boolean") {
        throw new Error("Invalid auth profile transfer handle");
      }
      cacheable = handle.cacheable;
    },
    readResult: (records) => ({
      store: records.get("store"),
      state: records.get("state"),
      cacheable,
    }),
  });
}

export function createSqliteOperationTransferReceiver(operation: string) {
  return createSqliteReadOnlyTransferReceiver<SqliteReadOnlyOperationResult>({
    kinds: ["result"],
    label: "SQLite operation",
    readResult(records) {
      const result = records.get("result");
      if (!isRecord(result) || result.operation !== operation || !("value" in result)) {
        throw new Error("SQLite read-only worker returned a different operation");
      }
      return { operation, value: result.value };
    },
  });
}
