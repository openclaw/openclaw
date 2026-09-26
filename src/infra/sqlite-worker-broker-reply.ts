import { deserialize, serialize } from "node:v8";
import { toErrorObject } from "@openclaw/normalization-core/error-coercion";
import { createDeferredCore } from "../shared/deferred.js";
import {
  retainOpenClawStateWorkerErrorPayload,
  hydrateOpenClawStateWorkerError,
  type OpenClawStateWorkerErrorPayload,
} from "../state/openclaw-state-worker-error.js";
import {
  acquireStateDatabaseSchemaLease,
  assertStateDatabaseAccessAllowed,
  type StateDatabaseSchemaLease,
} from "./gateway-state-owner.js";
import { retainSqliteWriteAdmissionService } from "./sqlite-transaction.js";
import { prepareSqliteWorkerActorContext } from "./sqlite-worker-broker-admission.js";
import type { Actor, Job, Slot } from "./sqlite-worker-broker.types.js";
import {
  SQLITE_WORKER_MAX_MESSAGE_BYTES,
  retainSqliteWorkerErrorCode,
  SqliteWorkerError,
  type SqliteWorkerReply,
  type SqliteWorkerCloseReceipt,
  type SqliteWorkerRequest,
} from "./sqlite-worker-contract.js";
import { createSqliteWorkerOperationAdmission } from "./sqlite-worker-operation-admission.js";
import type { SqliteWorkerOperationSettlement } from "./sqlite-worker-operation-settlement.js";
import {
  createSqliteWorkerTransferOwner,
  createSqliteWorkerTransferReceiver,
  type SqliteWorkerTransferFrame,
  type SqliteWorkerTransferHandle,
} from "./sqlite-worker-transfer.js";

export function dispatchSqliteWorkerJob(
  slot: Slot,
  job: Job,
  onRejected: (error: unknown, retire: boolean) => void,
): void {
  const actor = [...slot.actors].find((candidate) => candidate.id === job.request.actor);
  const assertCurrentJob = () => {
    if (slot.failed || slot.current !== job) {
      throw (
        slot.failed ?? new SqliteWorkerError("SQLite worker job is no longer current", "closed")
      );
    }
  };
  const assertDispatchable = () => {
    if (!job.nativeDispatched) {
      job.signal?.throwIfAborted();
    }
    job.assertCurrent?.();
    assertCurrentJob();
  };
  try {
    assertDispatchable();
    prepareSqliteWorkerActorContext(actor, job);
    job.request.operationAdmission = prepareSqliteWorkerOperationAdmission(
      job,
      actor,
      assertDispatchable,
      assertCurrentJob,
    );
    const request = prepareSqliteWorkerRequest(job);
    assertDispatchable();
    job.nativeDispatched = true;
    job.detach();
    if (job.dispatchState) {
      job.dispatchState.dispatched = true;
    }
    job.requestPosted = true;
    slot.worker.postMessage(
      request,
      request.operationAdmission ? [request.operationAdmission] : [],
    );
  } catch (error) {
    onRejected(error, job.requestPosted === true);
  }
}

function prepareSqliteWorkerOperationAdmission(
  job: Job,
  actor: Actor | undefined,
  assertDispatchable: () => void,
  assertCurrentJob: () => void,
) {
  const databasePath = job.request.stateDatabasePath ?? actor?.databasePath;
  if (!job.createAdmission && !databasePath) {
    return undefined;
  }
  const settlement = createDeferredCore<SqliteWorkerOperationSettlement>();
  job.settleNative = settlement.resolve;
  const retained = job.createAdmission
    ? job.createAdmission({ settled: settlement.promise })
    : {
        admission: createSqliteWorkerOperationAdmission(() => {
          throw new SqliteWorkerError(
            "SQLite domain operation requires its own admission",
            "closed",
          );
        }),
        nativeLocations: databasePath ? [databasePath] : [],
      };
  try {
    if (databasePath) {
      let schemaLease: StateDatabaseSchemaLease | undefined;
      const assertAccess = () => {
        assertCurrentJob();
        job.maintenanceScope?.assertAdmission();
        assertStateDatabaseAccessAllowed(databasePath, {
          maintenanceScope: job.maintenanceScope,
          schemaLease,
        });
      };
      retained.admission.bindDatabaseAuthority({
        databasePath,
        assertRequest: assertDispatchable,
        assertAccess,
        acquireSchema() {
          assertAccess();
          const acquire = () => acquireStateDatabaseSchemaLease(databasePath);
          const lease = job.maintenanceScope ? job.maintenanceScope.run(acquire) : acquire();
          schemaLease = lease;
          job.maintenanceScope?.own(lease, "shared-resources", () => lease.release());
          return {
            assertCurrent() {
              assertAccess();
              lease.assertCurrent();
            },
            release: () => lease.release(),
          };
        },
      });
    }
  } catch (error) {
    retained.admission.finish();
    throw error;
  }
  job.operationAdmission = {
    admission: retained.admission,
    // Native BEGIN services the live job's grants at the actual admitted database paths.
    releaseService: retainSqliteWriteAdmissionService(
      [
        ...retained.nativeLocations,
        ...(databasePath ? [databasePath] : []),
        ...(actor?.pathReferences.keys() ?? []),
      ],
      () => retained.admission.service(),
    ),
  };
  return retained.admission.port;
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

function decodeSqliteWorkerCleanupError(payload: OpenClawStateWorkerErrorPayload): Error {
  const failure = new Error("SQLite worker native cleanup failed");
  retainOpenClawStateWorkerErrorPayload(failure, payload);
  return hydrateOpenClawStateWorkerError(failure, { includeOrdinary: true });
}

export type CompletedSqliteWorkerOutcome = { value: unknown } | { error: unknown };

export type SqliteWorkerReplyOwner = {
  fail(
    reason: unknown,
    currentError?: Error,
    openOutcome?: "refused-before-agent-open",
    completed?: CompletedSqliteWorkerOutcome,
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
): void {
  const job = slot.current;
  if (!job || reply.id !== job.request.id) {
    owner.fail(new Error("SQLite worker returned an unexpected response"));
    return;
  }
  if (!reply.ok) {
    if (reply.cleanupFailure && job.nativeDispatched && !reply.retire) {
      const admission = job.operationAdmission?.admission;
      const failure =
        admission?.failureSource === "domain" && !reply.admissionRefused
          ? undefined
          : admission?.failure;
      const original = failure ?? decodeSqliteWorkerReplyError(job, reply.error);
      owner.fail(decodeSqliteWorkerCleanupError(reply.cleanupFailure), undefined, undefined, {
        error: original,
      });
      return;
    }
    if (reply.openNotEntered && job.request.type === "open" && job.dispatchState) {
      job.dispatchState.openNotEntered = true;
    }
    const error = decodeSqliteWorkerReplyError(job, reply.error);
    if (job.request.type === "open" && reply.openNotEntered && !reply.retire) {
      slot.current = undefined;
      const refusal = job.operationAdmission?.admission.failure ?? error;
      owner.finish(job, refusal, undefined, { kind: "not-entered", error: refusal });
      owner.dispatch();
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
        refusedOpen ? "refused-before-agent-open" : undefined,
      );
      return;
    }
    slot.current = undefined;
    owner.finish(job, job.operationAdmission?.admission.failure ?? error);
    owner.dispatch();
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
    const admission = job.operationAdmission?.admission;
    const failure = admission?.failureSource === "domain" ? undefined : admission?.failure;
    owner.fail(
      decodeSqliteWorkerCleanupError(reply.cleanupFailure),
      undefined,
      undefined,
      failure === undefined ? { value } : { error: failure },
    );
    return;
  }
  slot.current = undefined;
  if (job.request.type === "close") {
    owner.finish(job, undefined, value, undefined, reply.closeReceipt);
  } else {
    // Domains own handled refusal results; physical and request authority still fence delivery.
    const admission = job.operationAdmission?.admission;
    owner.finish(
      job,
      admission?.failureSource === "domain" ? undefined : admission?.failure,
      value,
    );
  }
  owner.dispatch();
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
  const retirement = retire();
  // Join native exit before releasing any operation that might have touched SQLite.
  const finishFailed = (retired: boolean, cleanupError?: unknown) => {
    if (current && completed) {
      process.emitWarning(
        new Error("SQLite worker operation completed before native cleanup failed", {
          cause: withSqliteWorkerCleanupFailure(error, cleanupError),
        }),
      );
      finish(
        current,
        "error" in completed ? completed.error : undefined,
        "value" in completed ? completed.value : undefined,
        retired ? { kind: "completed" } : { kind: "unknown", error: cleanupError ?? error },
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
    () => finishFailed(!current?.operationAdmission?.admission.cleanupFailures.length),
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
