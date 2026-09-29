import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { SqliteAuthProfileRows } from "./sqlite-readonly-worker-protocol.js";
import {
  SQLITE_WORKER_TRANSFER_FRAME_BYTES,
  createSqliteWorkerTransferReceiver,
  type SqliteWorkerTransferFrame,
} from "./sqlite-worker-transfer.js";

export type SqliteAuthTransferRequest = { type: "next" | "end"; transferId: number };

/** JSON IPC carries only one bounded byte frame; aggregate records retain the transfer contract. */
export function encodeSqliteAuthTransferFrame(frame: SqliteWorkerTransferFrame) {
  return frame.done ? frame : { ...frame, bytes: Buffer.from(frame.bytes).toString("base64") };
}

function decodeFrame(value: unknown): SqliteWorkerTransferFrame {
  if (
    !isRecord(value) ||
    typeof value.id !== "number" ||
    !Number.isSafeInteger(value.id) ||
    typeof value.sequence !== "number" ||
    !Number.isSafeInteger(value.sequence)
  ) {
    throw new Error("Invalid auth profile transfer frame");
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
        throw new Error("Invalid auth profile transfer counts");
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
    throw new Error("Invalid auth profile transfer bytes");
  }
  const bytes = Buffer.from(value.bytes, "base64");
  if (bytes.toString("base64") !== value.bytes) {
    throw new Error("Invalid auth profile transfer encoding");
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

export function createSqliteAuthTransferReceiver() {
  let receiver: ReturnType<typeof createSqliteWorkerTransferReceiver> | undefined;
  let transferId: number | undefined;
  let cacheable = false;
  let ending = false;
  let completed = false;
  const records = new Map<string, unknown>();
  return {
    accept(
      value: unknown,
    ): { request: SqliteAuthTransferRequest } | { rows: SqliteAuthProfileRows } {
      if (!isRecord(value) || completed) {
        throw new Error("Invalid auth profile transfer response");
      }
      if (value.type === "start" && !receiver) {
        const handle = value.handle;
        if (
          !isRecord(handle) ||
          typeof handle.id !== "number" ||
          !Number.isSafeInteger(handle.id) ||
          handle.id < 1 ||
          typeof handle.cacheable !== "boolean" ||
          !Array.isArray(handle.kinds) ||
          handle.kinds.length !== 2 ||
          handle.kinds[0] !== "store" ||
          handle.kinds[1] !== "state"
        ) {
          throw new Error("Invalid auth profile transfer handle");
        }
        transferId = handle.id;
        cacheable = handle.cacheable;
        receiver = createSqliteWorkerTransferReceiver(
          { id: transferId, kinds: ["store", "state"] },
          ({ kind, value: record }) => {
            if (records.has(kind)) {
              throw new Error("Duplicate auth profile transfer record");
            }
            records.set(kind, record);
          },
        );
        return { request: { type: "next", transferId } };
      }
      if (!receiver || transferId === undefined) {
        throw new Error("Auth profile transfer has not started");
      }
      if (value.type === "frame" && !ending) {
        const counts = receiver.accept(decodeFrame(value.frame));
        if (counts) {
          if (!records.has("store") || !records.has("state") || records.size !== 2) {
            throw new Error("Incomplete auth profile transfer result");
          }
          ending = true;
        }
        return { request: { type: ending ? "end" : "next", transferId } };
      }
      if (value.type === "complete" && ending) {
        completed = true;
        const rows = { store: records.get("store"), state: records.get("state"), cacheable };
        records.clear();
        return { rows };
      }
      throw new Error("Auth profile transfer response is out of order");
    },
  };
}
