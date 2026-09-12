import { deserialize, serialize } from "node:v8";
import { decodeOpenClawStateWorkerError } from "../state/openclaw-state-worker-error.js";
import type { Job } from "./sqlite-worker-broker.types.js";
import {
  SQLITE_WORKER_MAX_MESSAGE_BYTES,
  SqliteWorkerError,
  type SqliteWorkerReply,
  type SqliteWorkerRequest,
  type SqliteWorkerTransferHandle,
} from "./sqlite-worker-contract.js";
import {
  createSqliteWorkerTransferOwner,
  createSqliteWorkerTransferReceiver,
  type SqliteWorkerTransferFrame,
} from "./sqlite-worker-transfer.js";

export function prepareSqliteWorkerRequest(job: Job): SqliteWorkerRequest {
  if (
    job.request.type !== "execute" ||
    job.request.input.byteLength <= SQLITE_WORKER_MAX_MESSAGE_BYTES
  ) {
    return job.request;
  }
  const { input, ...request } = job.request;
  const producer = createSqliteWorkerTransferOwner();
  const transfer = producer.start([{ kind: "command", serialized: input }].values(), {
    kinds: ["command"],
  });
  job.inputTransfer = { id: transfer.id, producer };
  job.request.input = new Uint8Array();
  return { ...request, type: "execute-start", transfer };
}

export function decodeSqliteWorkerReplyValue(
  job: Job,
  reply: Extract<SqliteWorkerReply, { ok: true }>,
):
  | { type: "complete"; value: unknown }
  | {
      type: "continue";
      request: Extract<SqliteWorkerRequest, { type: "result-next" | "execute-frame" }>;
    } {
  if (reply.input === "next") {
    const transfer = job.inputTransfer;
    if (!transfer || reply.transfer) {
      throw new Error("SQLite worker requested unexpected command input");
    }
    const frame = transfer.producer.next(transfer.id);
    const input = serialize(frame);
    if (input.byteLength > SQLITE_WORKER_MAX_MESSAGE_BYTES) {
      throw new Error("SQLite worker input frame exceeds the transport byte limit");
    }
    if (frame.done) {
      transfer.producer.end(transfer.id);
      job.inputTransfer = undefined;
    }
    return {
      type: "continue",
      request: { type: "execute-frame", id: job.request.id, actor: job.request.actor, input },
    };
  }
  if (job.inputTransfer) {
    throw new Error("SQLite worker completed before receiving its command input");
  }
  let value: unknown;
  if (reply.transfer === "start") {
    // SAFETY: The matching worker emits this private handle; framing validates its records.
    const handle = deserialize(reply.value) as SqliteWorkerTransferHandle;
    if (
      job.request.type !== "execute" ||
      job.transfer ||
      handle.kinds.length !== 1 ||
      handle.kinds[0] !== "result"
    ) {
      throw new Error("SQLite worker returned an unexpected result transfer");
    }
    const transfer: NonNullable<Job["transfer"]> = {
      id: handle.id,
      value: undefined,
      receiver: createSqliteWorkerTransferReceiver(handle, (record) => {
        transfer.value = record.value;
      }),
    };
    job.transfer = transfer;
  } else if (reply.transfer === "frame") {
    const transfer = job.transfer;
    if (!transfer) {
      throw new Error("SQLite worker returned an unexpected result frame");
    }
    // SAFETY: The matching worker emits frames; the shared receiver validates their sequence and bounds.
    const frame = deserialize(reply.value) as SqliteWorkerTransferFrame;
    const counts = transfer.receiver.accept(frame);
    if (counts) {
      if (counts.length !== 1 || counts[0]?.[1] !== 1) {
        throw new Error("SQLite worker returned an incomplete result transfer");
      }
      value = transfer.value;
      job.transfer = undefined;
    }
  } else {
    if (job.transfer) {
      throw new Error("SQLite worker ended its result transfer without completion");
    }
    value = deserialize(reply.value);
  }
  return job.transfer
    ? {
        type: "continue",
        request: {
          type: "result-next",
          id: job.request.id,
          actor: job.request.actor,
          transferId: job.transfer.id,
        },
      }
    : { type: "complete", value };
}

export function decodeSqliteWorkerReplyError(
  job: Job,
  error: Extract<SqliteWorkerReply, { ok: false }>["error"],
): Error {
  const decoded =
    job.request.stateContext && error.code !== "outcome-unknown"
      ? decodeOpenClawStateWorkerError(error.sharedState)
      : undefined;
  const failure =
    decoded ??
    Object.assign(new Error(error.message), {
      name: error.name,
      ...(error.code === undefined ? {} : { code: error.code }),
    });
  return failure;
}

/** Keep the original failure and outcome classification when retirement also fails. */
export function withSqliteWorkerCleanupFailure(failure: Error, cleanupError: unknown): Error {
  if (cleanupError === undefined) {
    return failure;
  }
  const combined = new AggregateError(
    [failure, cleanupError],
    "SQLite worker failure and cleanup failed",
    { cause: failure },
  );
  return failure instanceof SqliteWorkerError
    ? Object.assign(combined, { code: failure.code })
    : combined;
}
