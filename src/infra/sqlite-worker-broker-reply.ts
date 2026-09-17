import { deserialize, serialize } from "node:v8";
import type { Worker } from "node:worker_threads";
import { toErrorObject } from "@openclaw/normalization-core/error-coercion";
import { createDeferredCore } from "../shared/deferred.js";
import { retainOpenClawStateWorkerErrorPayload } from "../state/openclaw-state-worker-error.js";
import { SqliteCoordinatorError } from "./sqlite-coordinator.js";
import { retainSqliteWriteAdmissionService } from "./sqlite-transaction.js";
import {
  prepareSqliteWorkerActorContext,
  prepareSqliteWorkerLifecycle,
  releaseSqliteWorkerLifecycle,
} from "./sqlite-worker-broker-admission.js";
import type { Job, Slot } from "./sqlite-worker-broker.types.js";
import {
  SQLITE_WORKER_MAX_MESSAGE_BYTES,
  retainSqliteWorkerErrorCode,
  SqliteWorkerError,
  type SqliteWorkerReply,
  type SqliteWorkerRequest,
  type SqliteWorkerTransferHandle,
} from "./sqlite-worker-contract.js";
import type { SqliteWorkerOperationSettlement } from "./sqlite-worker-operation-settlement.js";
import {
  createSqliteWorkerTransferOwner,
  createSqliteWorkerTransferReceiver,
  type SqliteWorkerTransferFrame,
} from "./sqlite-worker-transfer.js";

function dispatchSqliteWorkerJob(worker: Worker, job: Job): void {
  if (job.createAdmission) {
    const settlement = createDeferredCore<SqliteWorkerOperationSettlement>();
    job.settleNative = settlement.resolve;
    const retained = job.createAdmission({ settled: settlement.promise });
    job.operationAdmission = {
      admission: retained.admission,
      releaseService: retainSqliteWriteAdmissionService(retained.nativeLocations, () =>
        retained.admission.service(),
      ),
    };
    job.request.operationAdmission = retained.admission.port;
  }
  const request = prepareSqliteWorkerRequest(job);
  // A throwing transfer may still have reached the worker; failure joins its exit.
  job.nativeDispatched = true;
  worker.postMessage(
    request,
    [
      request.gatewaySchemaFence,
      request.maintenanceSchemaFence,
      request.stateLifecycle,
      request.operationAdmission,
    ].filter((port) => port !== undefined),
  );
  if (job.dispatchState) {
    job.dispatchState.dispatched = true;
  }
}

function prepareSqliteWorkerRequest(job: Job): SqliteWorkerRequest {
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

function decodeSqliteWorkerReplyValue(
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

function decodeSqliteWorkerReplyError(
  job: Job,
  error: Extract<SqliteWorkerReply, { ok: false }>["error"],
): Error {
  const failure = Object.assign(new Error(error.message), {
    name: error.name,
    ...(error.code === undefined ? {} : { code: error.code }),
  });
  if (job.request.stateContext && error.code !== "outcome-unknown" && error.sharedState) {
    retainOpenClawStateWorkerErrorPayload(failure, error.sharedState);
  }
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
  return retainSqliteWorkerErrorCode(combined, failure);
}

export function settleFailedSqliteWorkerJobs({
  queuedError,
  current,
  queued,
  error,
  currentError,
  retirement,
  finish,
}: {
  queuedError: Error;
  current: Job | undefined;
  queued: Job[];
  error: Error;
  currentError?: Error;
  retirement: Promise<void>;
  finish: typeof settleSqliteWorkerJob;
}): void {
  // Join native exit before releasing any operation that might have touched SQLite.
  const finishFailed = (cleanupError?: unknown) => {
    if (current) {
      finish(
        current,
        withSqliteWorkerCleanupFailure(
          currentError ??
            new SqliteWorkerError(
              `SQLite worker stopped before its result was received: ${error.message}`,
              current.request.type === "execute" ? "outcome-unknown" : "unavailable",
            ),
          cleanupError,
        ),
        undefined,
        current.nativeDispatched
          ? { kind: "unknown", error: currentError ?? error }
          : { kind: "not-entered", error },
      );
    }
    for (const job of queued) {
      finish(job, withSqliteWorkerCleanupFailure(queuedError, cleanupError));
    }
  };
  void retirement.then(() => finishFailed(), finishFailed);
}

export function settleSqliteWorkerJob(
  job: Job,
  error?: unknown,
  value?: unknown,
  settlement?: SqliteWorkerOperationSettlement,
): void {
  job.settleNative?.(
    settlement ?? (job.nativeDispatched ? { kind: "completed" } : { kind: "not-entered", error }),
  );
  job.operationAdmission?.admission.finish();
  job.operationAdmission?.releaseService();
  let failure = error;
  const admissionCleanupFailures = job.operationAdmission?.admission.cleanupFailures ?? [];
  if (admissionCleanupFailures.length > 0) {
    const cleanupError = new AggregateError(
      admissionCleanupFailures,
      "SQLite worker admission cleanup failed",
    );
    if (error === undefined && job.request.type === "execute") {
      process.emitWarning(cleanupError);
    } else {
      failure =
        error === undefined
          ? cleanupError
          : withSqliteWorkerCleanupFailure(
              toErrorObject(error, "SQLite worker failed"),
              cleanupError,
            );
    }
  }
  try {
    releaseSqliteWorkerLifecycle(job);
  } catch (cleanupError) {
    if (error === undefined && job.request.type === "execute") {
      process.emitWarning(
        new SqliteCoordinatorError(
          "SQLite worker result received before coordinator cleanup failed",
          cleanupError,
        ),
      );
    } else {
      failure =
        failure === undefined
          ? cleanupError
          : withSqliteWorkerCleanupFailure(
              toErrorObject(failure, "SQLite worker failed"),
              cleanupError,
            );
    }
  }
  job.inputTransfer?.producer.cancel();
  job.inputTransfer = undefined;
  job.transfer = undefined;
  job.detach();
  if (failure !== undefined) {
    job.reject(failure);
  } else {
    job.resolve(value);
  }
}

/** Bind transport events; the broker retains capacity, failure and retirement ownership. */
export function bindSqliteWorkerReplies(
  slot: Slot,
  {
    fail,
    finish,
    dispatch,
    onExit,
  }: {
    fail: (error: unknown, currentError?: Error) => void;
    finish: typeof settleSqliteWorkerJob;
    dispatch: () => void;
    onExit: () => void;
  },
): void {
  const { worker } = slot;
  worker.on("message", (reply: SqliteWorkerReply) => {
    const job = slot.current;
    if (!job || reply.id !== job.request.id) {
      fail(new Error("SQLite worker returned an unexpected response"));
      return;
    }
    if (!reply.ok) {
      if (reply.openNotEntered && job.request.type === "open" && job.dispatchState) {
        job.dispatchState.openNotEntered = true;
      }
      const error = decodeSqliteWorkerReplyError(job, reply.error);
      if (job.request.type === "open" && reply.openNotEntered && !reply.retire) {
        slot.current = undefined;
        const refusal = job.operationAdmission?.admission.failure ?? error;
        finish(job, refusal, undefined, { kind: "not-entered", error: refusal });
        dispatch();
        return;
      }
      if (job.request.type !== "execute" || reply.retire) {
        fail(error, job.request.type !== "execute" ? error : undefined);
        return;
      }
      slot.current = undefined;
      finish(job, job.operationAdmission?.admission.failure ?? error);
      dispatch();
      return;
    }
    let value: unknown;
    try {
      const result = decodeSqliteWorkerReplyValue(job, reply);
      if (result.type === "continue") {
        // Continuations retain the current job and its reserved transport credits through drain.
        slot.worker.postMessage(result.request, []);
        return;
      }
      value = result.value;
    } catch (error) {
      fail(error);
      return;
    }
    slot.current = undefined;
    finish(job, undefined, value);
    dispatch();
  });
  worker.on("error", (error) => fail(error));
  worker.on("messageerror", (error) => fail(error));
  worker.once("exit", (code) => {
    slot.exited = true;
    for (const actor of slot.actors) {
      actor.backendClosed = true;
    }
    fail(new Error(`SQLite worker exited with code ${code}`));
    onExit();
  });
}

export function dispatchSqliteWorkerSlotJob(
  slot: Slot,
  job: Job,
  {
    fail,
    finish,
    dispatch,
  }: {
    fail: (error: unknown, currentError?: Error) => void;
    finish: typeof settleSqliteWorkerJob;
    dispatch: () => void;
  },
): void {
  slot.current = job;
  job.detach();
  slot.worker.ref();
  try {
    job.assertCurrent?.();
    const actor = [...slot.actors].find((candidate) => candidate.id === job.request.actor);
    prepareSqliteWorkerActorContext(actor, job.request);
    prepareSqliteWorkerLifecycle(job, actor);
    dispatchSqliteWorkerJob(slot.worker, job);
  } catch (error) {
    if (
      job.request.gatewaySchemaFence ||
      job.request.maintenanceSchemaFence ||
      job.request.stateLifecycle ||
      job.request.operationAdmission
    ) {
      // A failed transfer cannot attest that the receiving native owner is gone.
      fail(error, toErrorObject(error, "SQLite worker transfer failed"));
    } else {
      slot.current = undefined;
      finish(job, error);
      dispatch();
    }
  }
}
