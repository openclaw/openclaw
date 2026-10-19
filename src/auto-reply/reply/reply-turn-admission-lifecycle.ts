import { addAbortListener } from "node:events";
import { scheduleMainSessionRecoveryPendingTarget } from "../../agents/main-session-recovery/main-session-recovery-owner-release.js";
import {
  releaseMainSessionRecoveryOwner,
  type MainSessionRecoveryOwnerLease,
  type MainSessionRecoveryPendingTarget,
} from "../../agents/main-session-recovery/main-session-recovery-store.js";
import { isAgentRunRestartAbortReason } from "../../agents/run-termination.js";
import type { SessionAdmissionDatabaseClaim } from "../../config/sessions/session-accessor.sqlite-entry-admission.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  getGatewayContextResolver,
  withPluginRuntimeGatewayContextResolver,
} from "../../plugins/runtime/gateway-request-scope.js";
import {
  registerReplyOperationSuccessorBarrier,
  runAfterReplyOperationClear,
  type ReplyOperation,
} from "../../sessions/session-controller.js";
import {
  withSessionControllerOwner,
  type SessionEffectRef,
} from "../../sessions/session-controller.lifecycle.js";
import {
  getAttachedBackend,
  lifecycleAdmissionByOperation,
} from "../../sessions/session-controller.state.js";
import type { ReplyTurnAdmissionParams } from "./reply-turn-admission.types.js";
import { bindReplyOperationDatabaseAdmission } from "./reply-turn-database-admission.js";

const log = createSubsystemLogger("auto-reply/reply-turn-admission");

/** Keeps heartbeat preemption ahead of both source-claim and direct-turn waits. */
export function yieldHeartbeatToReplyTurn(
  activeOperation: ReplyOperation | undefined,
  params: Pick<ReplyTurnAdmissionParams, "kind" | "upstreamAbortSignal" | "assertRequestCurrent">,
): void {
  if (params.kind !== "visible" || activeOperation?.turnKind !== "heartbeat") {
    return;
  }
  params.assertRequestCurrent?.();
  params.upstreamAbortSignal?.throwIfAborted();
  activeOperation.supersede();
}

export async function releaseReplyRecoveryOwner(
  lease: MainSessionRecoveryOwnerLease | undefined,
): Promise<MainSessionRecoveryPendingTarget | undefined> {
  if (!lease) {
    return undefined;
  }
  try {
    return await releaseMainSessionRecoveryOwner(lease);
  } catch (error) {
    log.warn(`failed to release main-session recovery reply owner: ${formatErrorMessage(error)}`);
    // The durable owner schedules exact-token retries. A completed reply must
    // not keep its successor barrier and lifecycle admission until that
    // background repair wins a contested SQLite write.
    return undefined;
  }
}

export function bindReplyAdmissionRelease(params: {
  operation: ReplyOperation;
  admission: SessionEffectRef | undefined;
  databaseClaim: SessionAdmissionDatabaseClaim | undefined;
  recoveryOwnerLease: MainSessionRecoveryOwnerLease | undefined;
  sessionId: string;
  sessionKey: string;
  workSignal?: AbortSignal;
}): void {
  const { operation, admission, databaseClaim, recoveryOwnerLease, sessionId, sessionKey } = params;
  const { operationAdmission, releaseWorkerDatabaseClaim } = bindReplyOperationDatabaseAdmission(
    operation,
    { sessionKey, workSignal: params.workSignal },
    admission,
    databaseClaim,
  );
  if (releaseWorkerDatabaseClaim) {
    let releasingForRestart = false;
    const releaseForRestart = (signal: AbortSignal) => {
      if (releasingForRestart || !isAgentRunRestartAbortReason(signal.reason)) {
        return;
      }
      releasingForRestart = true;
      const runId = getAttachedBackend(operation)?.runId ?? "unbound";
      // Release rejects later phases and joins requests already accepted by this borrow.
      void releaseWorkerDatabaseClaim().then(
        () =>
          log.info(`lease released: reason=restart-abort runId=${runId} kind=reply-admission`, {
            sessionId,
          }),
        (error: unknown) =>
          log.warn(
            `failed to release restart-aborted reply database owner: ${formatErrorMessage(error)}`,
          ),
      );
    };
    // Work cancellation can follow terminal settlement, when reply abort is already frozen.
    const restartReleases = [...new Set([operation.abortSignal, params.workSignal])].flatMap(
      (signal) => (signal ? [addAbortListener(signal, () => releaseForRestart(signal))] : []),
    );
    runAfterReplyOperationClear(operation, () => {
      for (const listener of restartReleases) {
        listener[Symbol.dispose]();
      }
    });
    registerReplyOperationSuccessorBarrier({
      operation,
      sessionId,
      sessionKeys: [sessionKey],
      start: releaseWorkerDatabaseClaim,
      deferUntilClear: true,
    });
  }
  if (admission) {
    // The lifecycle fence spans hooks, media, execution, and final delivery;
    // reset/delete waits for the owner to clear before mutating the session.
    let recoveryOwnerRelease: Promise<MainSessionRecoveryPendingTarget | undefined> | undefined;
    const releaseRecoveryOwner = () =>
      (recoveryOwnerRelease ??= releaseReplyRecoveryOwner(recoveryOwnerLease));
    if (recoveryOwnerLease) {
      registerReplyOperationSuccessorBarrier({
        operation,
        sessionId: recoveryOwnerLease.sessionId,
        sessionKeys: [sessionKey, recoveryOwnerLease.sessionKey],
        start: releaseRecoveryOwner,
      });
    }
    runAfterReplyOperationClear(operation, () => {
      // Keep immutable store correlation after releasing only this admission's lease.
      operationAdmission.lease = undefined;
      // Keep reset/delete behind durable owner release and its writer lock.
      void Promise.all([releaseRecoveryOwner(), releaseWorkerDatabaseClaim?.()]).then(
        ([pendingTarget]) => {
          admission.release();
          scheduleMainSessionRecoveryPendingTarget(pendingTarget);
        },
        (error: unknown) => {
          log.warn(`failed to release reply database owner: ${formatErrorMessage(error)}`);
        },
      );
    });
  }
  if (databaseClaim && !("kind" in databaseClaim)) {
    runAfterReplyOperationClear(operation, databaseClaim.release);
  }
}

/** Runs owner work with its admission marked as the initiating lifecycle context. */
export async function runWithReplyOperationLifecycleAdmission<T>(
  operation: ReplyOperation,
  run: () => Promise<T>,
): Promise<T> {
  const admission = lifecycleAdmissionByOperation.get(operation)?.lease;
  if (admission) {
    return await admission.run(() => withSessionControllerOwner(operation, run));
  }
  const resolver = getGatewayContextResolver(operation);
  return await withPluginRuntimeGatewayContextResolver(resolver, () =>
    withSessionControllerOwner(operation, run),
  );
}
