import { deserialize, serialize } from "node:v8";
import { toErrorObject } from "@openclaw/normalization-core/error-coercion";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { createDeferredCore } from "../shared/deferred.js";
import {
  retainOpenClawStateWorkerErrorPayload,
  hydrateOpenClawStateWorkerError,
  type OpenClawStateWorkerErrorPayload,
} from "../state/openclaw-state-worker-error.js";
import { SqliteCoordinatorError } from "./sqlite-coordinator.js";
import { retainSqliteWriteAdmissionService } from "./sqlite-transaction.js";
import {
  borrowSqliteWorkerLifecycle,
  prepareSqliteWorkerLifecycle,
  releaseSqliteWorkerLifecycle,
} from "./sqlite-worker-broker-admission.js";
import type { Actor, Job, Slot } from "./sqlite-worker-broker.types.js";
import {
  SQLITE_WORKER_MAX_MESSAGE_BYTES,
  retainSqliteWorkerErrorCode,
  SqliteWorkerError,
  type SqliteWorkerReply,
  type SqliteWorkerCloseReceipt,
  type SqliteWorkerRequest,
} from "./sqlite-worker-contract.js";
import { createSqliteWorkerLifecyclePreparation } from "./sqlite-worker-lifecycle-preparation.js";
import type { SqliteWorkerOperationSettlement } from "./sqlite-worker-operation-settlement.js";
import {
  createSqliteWorkerTransferOwner,
  createSqliteWorkerTransferReceiver,
  type SqliteWorkerTransferFrame,
  type SqliteWorkerTransferHandle,
} from "./sqlite-worker-transfer.js";
import { resolveStateDatabaseCoordinatorPath } from "./state-database-coordinator.js";

export function dispatchSqliteWorkerJob(
  slot: Slot,
  job: Job,
  onRejected: (error: unknown, retire: boolean) => void,
): void {
  const reject = (error: unknown, preparedNotEntered = false) => {
    let failure = error;
    let retire = job.preparation
      ? job.nativeDispatched === true || (job.requestPosted === true && !preparedNotEntered)
      : Boolean(
          job.request.gatewaySchemaFence ||
          job.request.maintenanceSchemaFence ||
          job.request.stateLifecycle ||
          job.request.operationAdmission,
        );
    if (
      job.preparation &&
      !job.nativeDispatched &&
      (!job.requestPosted || preparedNotEntered) &&
      slot.current === job
    ) {
      try {
        // No port reached native code. Release prepared custody before a follower can dispatch.
        releaseSqliteWorkerLifecycle(job);
      } catch (cleanupError) {
        // A revoked, unposted actor fence cannot serve another job until cleanup finishes.
        failure = withSqliteWorkerCleanupFailure(
          toErrorObject(error, "SQLite worker preparation failed"),
          cleanupError,
        );
        retire = true;
      }
    }
    onRejected(failure, retire);
  };
  job.rejectPreparation = (error) => reject(error, true);
  const actor = [...slot.actors].find((candidate) => candidate.id === job.request.actor);
  // Host grants must remain serviceable while a native caller waits on lifecycle custody.
  job.requireStateLifecycle ||=
    (job.request.stateContext ?? actor?.stateContext) !== undefined &&
    (job.request.type === "close" ||
      (job.request.type === "execute" && job.createAdmission !== undefined));
  if (job.requireStateLifecycle) {
    job.cancelPreparation = new AbortController();
  }
  const assertDispatchable = () => {
    job.assertCurrent?.();
    job.cancelPreparation?.signal.throwIfAborted();
    if (slot.failed || slot.current !== job) {
      throw (
        slot.failed ?? new SqliteWorkerError("SQLite worker job is no longer current", "closed")
      );
    }
  };
  try {
    assertDispatchable();
    const dispatch = () => {
      try {
        assertDispatchable();
        postSqliteWorkerJob(slot, job, assertDispatchable, actor);
      } catch (error) {
        reject(error);
      }
    };
    prepareSqliteWorkerLifecycle(job, actor, assertDispatchable);
    if (job.requireStateLifecycle && !job.request.workerStateLifecycle) {
      job.preparation = Promise.resolve();
      void job.preparation.then(dispatch, reject);
    } else {
      dispatch();
    }
  } catch (error) {
    reject(error);
  }
}

function postSqliteWorkerJob(
  slot: Slot,
  job: Job,
  assertDispatchable: () => void,
  actor: Actor | undefined,
): void {
  const dispatched = () => {
    job.nativeDispatched = true;
    job.detach();
    if (job.dispatchState) {
      job.dispatchState.dispatched = true;
    }
  };
  if (job.request.workerStateLifecycle) {
    const context = job.request.stateContext;
    if (!actor || !context || !job.cancelPreparation) {
      throw new Error("Worker lifecycle preparation requires its captured owner");
    }
    const preparation = createSqliteWorkerLifecyclePreparation({
      assertCurrent: assertDispatchable,
      signal: job.cancelPreparation.signal,
      borrow: () => borrowSqliteWorkerLifecycle(job, actor),
      admit: () => prepareSqliteWorkerOperationAdmission(job, actor),
      dispatch: dispatched,
      receiveResult(reply, pumping) {
        if (!isRecord(reply) || typeof reply.id !== "number" || typeof reply.ok !== "boolean") {
          throw new Error("SQLite lifecycle reply is invalid");
        }
        // SAFETY: This private port carries the same trusted worker reply as its message event.
        slot.receiveReply(reply as SqliteWorkerReply, pumping);
      },
    });
    const releaseService = retainSqliteWriteAdmissionService(
      [
        resolveStateDatabaseCoordinatorPath({
          databasePath: job.request.stateDatabasePath ?? actor.databasePath,
          runtimeDirectory: context.coordinatorRuntime.directory,
          uid: typeof process.getuid === "function" ? process.getuid() : undefined,
        }),
      ],
      () => {
        preparation.service();
        job.operationAdmission?.admission.service();
      },
    );
    job.lifecyclePreparation = {
      get failure() {
        return preparation.failure;
      },
      finish() {
        releaseService();
        preparation.finish();
      },
    };
    job.preparation = preparation.prepared;
    job.request.lifecyclePreparation = preparation.port;
  } else {
    job.request.operationAdmission = prepareSqliteWorkerOperationAdmission(job, actor);
  }
  const request = prepareSqliteWorkerRequest(job);
  assertDispatchable();
  // A throwing transfer may still have reached the worker; failure joins its exit.
  if (!job.request.workerStateLifecycle) {
    dispatched();
  }
  job.requestPosted = true;
  slot.worker.postMessage(
    request,
    [
      request.gatewaySchemaFence,
      request.maintenanceSchemaFence,
      request.stateLifecycle,
      request.operationAdmission,
      request.lifecyclePreparation,
    ].filter((port) => port !== undefined),
  );
}

function prepareSqliteWorkerOperationAdmission(job: Job, actor: Actor | undefined) {
  if (job.createAdmission) {
    const settlement = createDeferredCore<SqliteWorkerOperationSettlement>();
    job.settleNative = settlement.resolve;
    const retained = job.createAdmission({ settled: settlement.promise });
    job.operationAdmission = {
      admission: retained.admission,
      // SQLite reports canonical paths; retain the physical owner's already-admitted
      // aliases so a native writer can service this grant without filesystem discovery.
      releaseService: retainSqliteWriteAdmissionService(
        [...retained.nativeLocations, ...(actor?.pathReferences.keys() ?? [])],
        () => retained.admission.service(),
      ),
    };
    return retained.admission.port;
  }
  return undefined;
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

function decodeSqliteWorkerCleanupError(job: Job, payload: OpenClawStateWorkerErrorPayload): Error {
  return hydrateOpenClawStateWorkerError(
    decodeSqliteWorkerReplyError(job, {
      name: "SqliteCoordinatorError",
      message: "SQLite coordinator cleanup failed",
      sharedState: payload,
    }),
  );
}

export type SqliteWorkerReplyOwner = {
  fail(
    reason: unknown,
    currentError?: Error,
    completed?: CompletedSqliteWorkerOutcome,
    openOutcome?: "refused-before-agent-open",
  ): void;
  finish(
    job: Job,
    error?: unknown,
    value?: unknown,
    settlement?: SqliteWorkerOperationSettlement,
    closeReceipt?: SqliteWorkerCloseReceipt,
  ): void;
  dispatch(): void;
};

export function receiveSqliteWorkerReply(
  slot: Pick<Slot, "current" | "failed"> & { worker: Pick<Slot["worker"], "postMessage"> },
  reply: SqliteWorkerReply,
  owner: SqliteWorkerReplyOwner,
  pumping = false,
): void {
  const job = slot.current;
  if (!job || reply.id !== job.request.id) {
    owner.fail(new Error("SQLite worker returned an unexpected response"));
    return;
  }
  const settle = (operation: () => void) => {
    if (pumping) {
      queueMicrotask(() => {
        if (slot.current === job && !slot.failed) {
          operation();
        }
      });
    } else {
      operation();
    }
  };
  if (!reply.ok) {
    if (reply.cleanupFailure && job.nativeDispatched && !reply.retire) {
      const original =
        job.operationAdmission?.admission.failure ?? decodeSqliteWorkerReplyError(job, reply.error);
      owner.fail(decodeSqliteWorkerCleanupError(job, reply.cleanupFailure), undefined, {
        error: original,
      });
      return;
    }
    if (reply.openNotEntered && job.request.type === "open" && job.dispatchState) {
      job.dispatchState.openNotEntered = true;
    }
    const error = decodeSqliteWorkerReplyError(job, reply.error);
    if (job.request.type === "open" && reply.openNotEntered && !reply.retire) {
      settle(() => {
        slot.current = undefined;
        const refusal = job.operationAdmission?.admission.failure ?? error;
        owner.finish(job, refusal, undefined, { kind: "not-entered", error: refusal });
        owner.dispatch();
      });
      return;
    }
    if (job.request.type !== "execute" || reply.retire) {
      const refusedOpen =
        job.request.type === "open" && reply.openOutcome === "refused-before-agent-open";
      const failure =
        refusedOpen || (job.request.type === "open" && reply.admissionRefused)
          ? toErrorObject(job.operationAdmission?.admission.failure ?? error, error.message)
          : error;
      owner.fail(
        failure,
        job.request.type !== "execute" ? failure : undefined,
        undefined,
        refusedOpen ? "refused-before-agent-open" : undefined,
      );
      return;
    }
    if (job.lifecyclePreparation && !job.nativeDispatched) {
      settle(() => {
        job.lifecyclePreparation?.finish();
        job.rejectPreparation?.(job.lifecyclePreparation?.failure ?? error);
      });
      return;
    }
    settle(() => {
      slot.current = undefined;
      owner.finish(
        job,
        job.lifecyclePreparation?.failure ?? job.operationAdmission?.admission.failure ?? error,
      );
      owner.dispatch();
    });
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
    owner.fail(error);
    return;
  }
  if (reply.cleanupFailure) {
    owner.fail(decodeSqliteWorkerCleanupError(job, reply.cleanupFailure), undefined, {
      value,
    });
    return;
  }
  settle(() => {
    slot.current = undefined;
    if (job.request.type === "close") {
      owner.finish(job, undefined, value, undefined, reply.closeReceipt);
    } else {
      owner.finish(job, undefined, value);
    }
    owner.dispatch();
  });
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

export type CompletedSqliteWorkerOutcome = { value: unknown } | { error: unknown };

export function settleFailedSqliteWorkerJobs({
  queuedError,
  current,
  queued,
  error,
  currentError,
  completed,
  openOutcome,
  retire,
  finish,
}: {
  queuedError: Error;
  current: Job | undefined;
  queued: Job[];
  error: Error;
  currentError?: Error;
  completed?: CompletedSqliteWorkerOutcome;
  openOutcome?: "refused-before-agent-open";
  retire: () => Promise<void>;
  finish: typeof settleSqliteWorkerJob;
}): void {
  current?.cancelPreparation?.abort(error);
  // Failed preparation must settle before retirement can release any actor custody.
  const retirement = current?.lifecyclePreparation
    ? retire().finally(() => current.lifecyclePreparation?.finish())
    : current?.preparation
      ? current.preparation.catch(() => undefined).then(retire)
      : retire();
  // Join native exit before releasing any operation that might have touched SQLite.
  const finishFailed = (retired: boolean, cleanupError?: unknown) => {
    if (current && completed) {
      process.emitWarning(
        new SqliteCoordinatorError(
          "SQLite worker operation completed before coordinator cleanup failed",
          withSqliteWorkerCleanupFailure(error, cleanupError),
        ),
      );
      finish(
        current,
        "error" in completed ? completed.error : undefined,
        "value" in completed ? completed.value : undefined,
        { kind: "completed" },
      );
    } else if (current) {
      const failure =
        currentError ??
        new SqliteWorkerError(
          `SQLite worker stopped before its result was received: ${error.message}`,
          current.request.type === "execute" && current.nativeDispatched
            ? "outcome-unknown"
            : "unavailable",
        );
      if (!currentError) {
        failure.cause = error;
      }
      finish(
        current,
        withSqliteWorkerCleanupFailure(failure, cleanupError),
        undefined,
        current.nativeDispatched
          ? retired && openOutcome === "refused-before-agent-open"
            ? { kind: "completed" }
            : { kind: "unknown", error: currentError ?? error }
          : { kind: "not-entered", error },
      );
    }
    for (const job of queued) {
      finish(job, withSqliteWorkerCleanupFailure(queuedError, cleanupError));
    }
  };
  void retirement.then(
    () => {
      let cleanupComplete = true;
      try {
        if (current && openOutcome === "refused-before-agent-open") {
          // The job's lifecycle is not among its actor's retained cleanup until release fails.
          releaseSqliteWorkerLifecycle(current);
          cleanupComplete = !current.operationAdmission?.admission.cleanupFailures.length;
        }
      } catch (cleanupError) {
        finishFailed(false, cleanupError);
        return;
      }
      finishFailed(cleanupComplete);
    },
    (cleanupError: unknown) => finishFailed(false, cleanupError),
  );
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
  job.lifecyclePreparation?.finish();
  let failure = error;
  const retainCleanupFailure = (cleanupError: unknown) => {
    failure =
      failure === undefined
        ? cleanupError
        : withSqliteWorkerCleanupFailure(
            toErrorObject(failure, "SQLite worker failed"),
            cleanupError,
          );
  };
  const admissionCleanupFailures = job.operationAdmission?.admission.cleanupFailures ?? [];
  if (admissionCleanupFailures.length > 0) {
    const cleanupError = new AggregateError(
      admissionCleanupFailures,
      "SQLite worker admission cleanup failed",
    );
    if (error === undefined && job.request.type === "execute") {
      process.emitWarning(cleanupError);
    } else {
      retainCleanupFailure(cleanupError);
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
      retainCleanupFailure(cleanupError);
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
