import { deserialize, serialize } from "node:v8";
import { toErrorObject } from "@openclaw/normalization-core/error-coercion";
import { sleepWithAbort } from "@openclaw/retry";
import { createDeferredCore } from "../shared/deferred.js";
import { notifyListeners } from "../shared/listeners.js";
import { OPENCLAW_SQLITE_BUSY_TIMEOUT_MS } from "../state/openclaw-state-db-contract.js";
import { resolveQuarantineStorePath } from "../state/openclaw-state-db.paths.js";
import {
  retainOpenClawStateWorkerErrorPayload,
  hydrateOpenClawStateWorkerError,
  type OpenClawStateWorkerErrorPayload,
} from "../state/openclaw-state-worker-error.js";
import { acquireWithWait } from "./acquire-with-wait.js";
import { resolveIdentityPathViaExistingAncestorSync } from "./boundary-path.js";
import { StateDatabaseAdmissionPendingError } from "./gateway-state-owner-errors.js";
import {
  acquireStateDatabaseSchemaLease,
  type StateDatabaseSchemaLease,
} from "./gateway-state-owner.js";
import { runWithMainThreadTask } from "./main-thread-stall.js";
import { installSqliteNativeRuntimeAdmission } from "./node-sqlite.js";
import {
  captureSqliteDatabaseAdmissions,
  createSqliteDatabaseAdmissionCursor,
} from "./sqlite-database-admission.js";
import { retainSqliteWriteAdmissionService } from "./sqlite-transaction.js";
import { prepareSqliteWorkerActorContext } from "./sqlite-worker-broker-admission.js";
import type { Actor, Job, Slot } from "./sqlite-worker-broker.types.js";
import {
  SQLITE_WORKER_MAX_MESSAGE_BYTES,
  retainSqliteWorkerErrorCode,
  SqliteWorkerAdmissionTimeoutError,
  SqliteWorkerError,
  type SqliteWorkerReply,
  type SqliteWorkerRequest,
} from "./sqlite-worker-contract.js";
import {
  bindSqliteWorkerDatabaseAdmissionCursor,
  createSqliteWorkerOperationAdmission,
  readSqliteWorkerExecutionAuthority,
} from "./sqlite-worker-operation-admission.js";
import type { SqliteWorkerOperationSettlement } from "./sqlite-worker-operation-settlement.js";
import { readSqliteWorkerRequestCustody } from "./sqlite-worker-request-custody.js";
import {
  createSqliteWorkerTransferOwner,
  createSqliteWorkerTransferReceiver,
  type SqliteWorkerTransferFrame,
  type SqliteWorkerTransferHandle,
} from "./sqlite-worker-transfer.js";
import { ownedWorkerBytes } from "./worker-transfer-bytes.js";

export async function dispatchSqliteWorkerJob(
  slot: Slot,
  job: Job,
  onRejected: (error: unknown, retire: boolean) => void,
): Promise<void> {
  const actor = [...slot.actors].find((candidate) => candidate.id === job.request.actor);
  const assertCurrentJob = () => {
    if (!readSqliteWorkerRequestCustody(job.custody.descriptor)) {
      throw (
        slot.failed ?? new SqliteWorkerError("SQLite worker job is no longer current", "closed")
      );
    }
  };
  const assertDispatchable = () => {
    if (!job.custody.dispatched) {
      job.signal?.throwIfAborted();
    }
    job.assertCurrent?.();
    assertCurrentJob();
  };
  try {
    job.signal?.throwIfAborted();
    assertCurrentJob();
    const deliveredStateContext = prepareSqliteWorkerActorContext(actor, job);
    const stateAccess = actor?.stateAccess;
    const databasePath = stateAccess?.canonicalPath;
    // Retirement must drain even after ordinary database access is revoked.
    if (stateAccess && job.request.type !== "close") {
      const assertAccessAllowed = () => {
        job.signal?.throwIfAborted();
        assertCurrentJob();
        stateAccess.assertAccessAllowed({
          maintenanceScope: job.maintenanceScope,
          schemaLease: job.cleanupAccess,
        });
      };
      const isPending = (error: unknown) =>
        error instanceof StateDatabaseAdmissionPendingError && error.databasePath === databasePath;
      try {
        assertAccessAllowed();
      } catch (error) {
        if (!isPending(error)) {
          throw error;
        }
        // Keep the queue slot, but create no admission and send no command until custody clears.
        await acquireWithWait({
          acquire: assertAccessAllowed,
          shouldRetry: isPending,
          deadlineMs: performance.now() + OPENCLAW_SQLITE_BUSY_TIMEOUT_MS,
          pollIntervalMs: 10,
          sleep: (ms) => sleepWithAbort(ms, job.signal),
        });
      }
    }
    if (job.createAdmission || databasePath) {
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
        bindSqliteWorkerDatabaseAdmissionCursor(
          retained.admission,
          slot.databaseAdmissionCursor,
          () => (slot.databaseAdmissionCursor = createSqliteDatabaseAdmissionCursor()),
        );
        if (databasePath) {
          const assertCreate = (location: string) => {
            const creationPaths = new Set<string>();
            if (job.request.type === "open" && !job.request.existingIdentity) {
              creationPaths.add(
                resolveIdentityPathViaExistingAncestorSync(job.request.databasePath),
              );
              creationPaths.add(resolveIdentityPathViaExistingAncestorSync(databasePath));
            }
            // Existing agents prepare lazily; only their original captured companions may be created.
            if (actor?.stateContext) {
              const primary = resolveIdentityPathViaExistingAncestorSync(actor.databasePath);
              for (const companion of [
                actor.stateDatabasePath,
                resolveQuarantineStorePath(actor.stateContext.environment),
              ]) {
                if (companion) {
                  const target = resolveIdentityPathViaExistingAncestorSync(companion);
                  if (target !== primary) {
                    creationPaths.add(target);
                  }
                }
              }
            }
            if (!creationPaths.has(resolveIdentityPathViaExistingAncestorSync(location))) {
              throw new SqliteWorkerError(
                "SQLite creation target differs from its captured database",
                "closed",
              );
            }
          };
          let schemaLease: StateDatabaseSchemaLease | undefined;
          const assertAccess = () => {
            assertCurrentJob();
            job.maintenanceScope?.assertAdmission();
            actor?.stateAccess.assertReadAllowed({
              maintenanceScope: job.maintenanceScope,
              schemaLease: schemaLease ?? job.cleanupAccess,
            });
          };
          retained.admission.bindDatabaseAuthority({
            databasePath,
            ...(job.request.type === "open" &&
            !job.request.existingIdentity &&
            resolveIdentityPathViaExistingAncestorSync(job.request.databasePath) ===
              resolveIdentityPathViaExistingAncestorSync(databasePath)
              ? { coldOpenPath: databasePath }
              : {}),
            assertRequest: assertDispatchable,
            assertAccess,
            ...(job.request.type === "close" ? {} : { assertCreate }),
            acquireSchema() {
              assertAccess();
              const acquire = () => acquireStateDatabaseSchemaLease(databasePath);
              const lease = job.maintenanceScope ? job.maintenanceScope.run(acquire) : acquire();
              schemaLease = lease;
              job.maintenanceScope?.own(lease, "shared-resources", () => lease.release());
              return lease;
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
      job.request.executionAuthority = readSqliteWorkerExecutionAuthority(retained.admission);
      job.request.operationAttachment = retained.admission.attachment;
      job.request.operationAdmission = retained.admission.port;
    } else {
      job.request.operationAdmission = undefined;
    }
    const databaseAdmissions = captureSqliteDatabaseAdmissions(slot.databaseAdmissionCursor);
    if (databaseAdmissions.length > 0) {
      job.request.databaseAdmissions = databaseAdmissions;
    }
    job.request.timing = job.observation.timing;
    job.request.requestCustody = job.custody.descriptor;
    const request = prepareSqliteWorkerRequest(job);
    assertDispatchable();
    job.custody.accept();
    job.detach();
    if (actor && request.type !== "close") {
      // A later request may open or write natively even if its reply is lost.
      actor.openDispatch.openRefused = false;
    }
    job.custody.post();
    if (request.timing) {
      request.timing.posted = performance.now();
    }
    // Serialized commands are owned by this dispatch; custody keeps their byte charge until settlement.
    slot.worker.postMessage(request, [
      ...(request.operationAdmission ? [request.operationAdmission] : []),
      ...("input" in request ? [request.input.buffer] : []),
      ...(request.type === "open" && request.preparation ? [request.preparation.buffer] : []),
    ]);
    if (actor && deliveredStateContext) {
      actor.deliveredStateContext = deliveredStateContext;
    }
    if (request.timing) {
      request.timing.postFinished = performance.now();
    }
  } catch (error) {
    // A refused dispatch may have captured a publication without delivering it.
    slot.databaseAdmissionCursor = createSqliteDatabaseAdmissionCursor();
    onRejected(error, job.custody.postAttempted);
  }
}

function prepareSqliteWorkerRequest(job: Job): SqliteWorkerRequest {
  if (
    job.request.type !== "execute" ||
    job.request.input.byteLength <= SQLITE_WORKER_MAX_MESSAGE_BYTES
  ) {
    // Bun's serializer can return shared storage; dispatch must own transferable bytes.
    if ("input" in job.request) {
      job.request.input = ownedWorkerBytes(job.request.input);
    }
    if (job.request.type === "open" && job.request.preparation) {
      job.request.preparation = ownedWorkerBytes(job.request.preparation);
    }
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
    const input = ownedWorkerBytes(serialize(frame));
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
  error: Extract<SqliteWorkerReply, { ok: false }>["error"],
): Error {
  if (error.name === "SqliteWorkerAdmissionTimeoutError" && error.code === "admission-timeout") {
    return new SqliteWorkerAdmissionTimeoutError();
  }
  if (error.name === "SqliteWorkerError" && error.code === "outcome-unknown") {
    return new SqliteWorkerError(error.message, "outcome-unknown");
  }
  const failure = Object.assign(new Error(error.message), {
    name: error.name,
    ...(error.code === undefined ? {} : { code: error.code }),
  });
  if (error.sharedState) {
    retainOpenClawStateWorkerErrorPayload(failure, error.sharedState);
    return hydrateOpenClawStateWorkerError(failure, { includeOrdinary: true });
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
  ): void;
  dispatch(): void;
};

export function receiveSqliteWorkerReply(
  slot: Pick<Slot, "current" | "failed"> & {
    actors: ReadonlySet<Pick<Actor, "id" | "closeReceipt" | "openDispatch">>;
    worker: Pick<Slot["worker"], "postMessage">;
  },
  reply: SqliteWorkerReply,
  owner: SqliteWorkerReplyOwner,
): void {
  const job = slot.current;
  if (!job || reply.id !== job.request.id) {
    owner.fail(new Error("SQLite worker returned an unexpected response"));
    return;
  }
  if (reply.transactionCount !== undefined) {
    job.observation.recordTransactions?.(reply.transactionCount);
  }
  if (job.observation.timing && reply.timing) {
    Object.assign(job.observation.timing, reply.timing, { replyReceived: performance.now() });
  }
  if (!reply.ok) {
    const admission = job.operationAdmission?.admission;
    if (reply.cleanupFailure && job.custody.dispatched && !reply.retire) {
      const failure =
        admission?.failureSource === "domain" && !reply.admissionRefused
          ? undefined
          : admission?.failure;
      const original = failure ?? decodeSqliteWorkerReplyError(reply.error);
      owner.fail(decodeSqliteWorkerCleanupError(reply.cleanupFailure), undefined, undefined, {
        error: original,
      });
      return;
    }
    if (reply.openNotEntered && job.request.type === "open" && job.dispatchState) {
      job.dispatchState.openNotEntered = true;
    }
    const error = decodeSqliteWorkerReplyError(reply.error);
    const openRefused = reply.openOutcome === "refused-before-agent-open";
    if (!reply.retire && (openRefused || (job.request.type === "open" && reply.openNotEntered))) {
      job.custody.retire();
      slot.current = undefined;
      const refusal = admission?.failure ?? error;
      owner.finish(
        job,
        refusal,
        undefined,
        reply.openNotEntered ? { kind: "not-entered", error: refusal } : { kind: "completed" },
      );
      if (openRefused) {
        const actor = [...slot.actors].find((candidate) => candidate.id === job.request.actor);
        if (actor) {
          actor.openDispatch.openRefused = !admission?.cleanupFailures.length;
        }
      }
      owner.dispatch();
      return;
    }
    if (job.request.type !== "execute" || reply.retire) {
      const refusedFactory = job.request.type === "open" && openRefused;
      const failure =
        refusedFactory || reply.admissionRefused
          ? toErrorObject(admission?.failure ?? error, error.message)
          : error;
      owner.fail(
        failure,
        job.request.type !== "execute" || reply.admissionRefused ? failure : undefined,
        refusedFactory ? "refused-before-agent-open" : undefined,
      );
      return;
    }
    job.custody.retire();
    slot.current = undefined;
    owner.finish(job, admission?.failure ?? error);
    owner.dispatch();
    return;
  }
  let value: unknown;
  try {
    const result = runWithMainThreadTask("worker:sqlite:reply-decode", () =>
      decodeSqliteWorkerReplyValue(job, reply),
    );
    if (result.type === "continue") {
      // Continuations retain the current job and its reserved transport credits through drain.
      slot.worker.postMessage(
        result.request,
        result.request.type === "execute-frame" ? [result.request.input.buffer] : [],
      );
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
  if (reply.nativeRuntimeAdmission !== undefined) {
    // Completion can create a sibling immediately; publish only after the full reply settles.
    installSqliteNativeRuntimeAdmission(reply.nativeRuntimeAdmission);
  }
  job.custody.retire();
  slot.current = undefined;
  if (job.request.type === "close") {
    if (reply.closeReceipt) {
      const actor = [...slot.actors].find((candidate) => candidate.id === job.request.actor);
      if (actor) {
        actor.closeReceipt = reply.closeReceipt;
      }
    }
    owner.finish(job, undefined, value);
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

export function failSqliteWorkerSlot(
  slot: Pick<Slot, "failed" | "current" | "queue" | "custody"> & {
    actors: ReadonlySet<Pick<Actor, "backendClosed" | "nativeLostObservers">>;
  },
  reason: unknown,
  owner: {
    currentError?: Error;
    openOutcome?: "refused-before-agent-open";
    completed?: CompletedSqliteWorkerOutcome;
    waiters?: Iterable<(error?: unknown) => void>;
    retire: () => Promise<void>;
    finish: typeof settleSqliteWorkerJob;
  },
): void {
  if (slot.failed) {
    return;
  }
  const error = toErrorObject(reason, "SQLite worker failed");
  slot.custody.retire();
  slot.failed = new SqliteWorkerError(error.message, "unavailable");
  slot.failed.cause = error;
  for (const actor of slot.actors) {
    if (!actor.backendClosed) {
      notifyListeners(actor.nativeLostObservers ?? [], slot.failed);
    }
  }
  for (const resume of owner.waiters ?? []) {
    resume(slot.failed);
  }
  const current = slot.current;
  current?.custody.retire();
  slot.current = undefined;
  if (current) {
    current.inputTransfer?.producer.cancel();
    current.inputTransfer = undefined;
    current.transfer = undefined;
  }
  const { currentError, completed, openOutcome, retire, finish } = owner;
  const queuedError = slot.failed;
  const queued = slot.queue.splice(0);
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
          current.request.type === "execute" && current.custody.dispatched
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
        current.custody.dispatched
          ? retired && openOutcome === "refused-before-agent-open"
            ? { kind: "completed" }
            : {
                kind: "unknown",
                error: currentError ?? error,
                ...(retired ? { nativeStopped: true as const } : {}),
              }
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
  job.custody.retire();
  job.settleNative?.(
    settlement ?? (job.custody.dispatched ? { kind: "completed" } : { kind: "not-entered", error }),
  );
  job.operationAdmission?.admission.finish();
  job.operationAdmission?.releaseService();
  // finish() drains the receipt port before the separate command reply can acknowledge success.
  const admission = job.operationAdmission?.admission;
  let failure = error ?? (admission?.failureSource === "domain" ? undefined : admission?.failure);
  const admissionCleanupFailures = job.operationAdmission?.admission.cleanupFailures ?? [];
  if (admissionCleanupFailures.length > 0) {
    // Cleanup uncertainty supersedes the worker's pre-open refusal certificate.
    if (job.dispatchState) {
      job.dispatchState.openRefused = false;
    }
    const cleanupError = new AggregateError(
      admissionCleanupFailures,
      "SQLite worker admission cleanup failed",
    );
    if (failure === undefined && job.request.type === "execute") {
      process.emitWarning(cleanupError);
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
