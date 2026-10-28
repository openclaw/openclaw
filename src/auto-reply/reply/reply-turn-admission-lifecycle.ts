import { addAbortListener } from "node:events";
import { scheduleMainSessionRecoveryPendingTarget } from "../../agents/main-session-recovery/main-session-recovery-owner-release.js";
import {
  releaseMainSessionRecoveryOwner,
  type MainSessionRecoveryOwnerLease,
  type MainSessionRecoveryPendingTarget,
} from "../../agents/main-session-recovery/main-session-recovery-store.js";
import { isAgentRunRestartAbortReason } from "../../agents/run-termination.js";
import { SessionWorkStartChangedError } from "../../config/sessions/lifecycle.js";
import type { SessionAdmissionDatabaseClaim } from "../../config/sessions/session-accessor.sqlite-entry-admission.js";
import type { SessionActor } from "../../config/sessions/session-actor-contract.js";
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
  type ReplyOperationAdmission,
} from "../../sessions/session-controller.state.js";

const log = createSubsystemLogger("auto-reply/reply-turn-admission");

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
  let handoff: Promise<void> | undefined;
  let releasing: Promise<void> | undefined;
  let sessionActor: Promise<SessionActor | undefined> | undefined;
  const assertReaderOperation = () => {
    operation.abortSignal.throwIfAborted();
    // Terminal settlement can freeze reply abort while restart still retires its work owner.
    if (releasing) {
      params.workSignal?.throwIfAborted();
    }
    if (releasing || operation.key !== sessionKey) {
      throw new SessionWorkStartChangedError(
        "Session reader operation is no longer current. Retry the turn.",
      );
    }
  };
  const assertTransitionActive = () => {
    assertReaderOperation();
    if (operation.result) {
      throw new SessionWorkStartChangedError("Reply transition is no longer active");
    }
  };
  const releaseSessionActor = async () => {
    const pending = sessionActor;
    const installed = operationAdmission.sessionActor;
    sessionActor = undefined;
    operationAdmission.sessionActor = undefined;
    if (installed) {
      await installed.release();
      return;
    }
    // Acquisition failures already belong to their caller; release only accepted custody.
    const actor = await pending?.catch(() => undefined);
    await actor?.release();
  };
  const operationAdmission: ReplyOperationAdmission = {
    lease: admission,
    databaseIdentity: databaseClaim?.identity,
    databaseClaim,
    reader: databaseClaim && "kind" in databaseClaim ? databaseClaim.reader : undefined,
    sessionTarget: databaseClaim && "kind" in databaseClaim ? databaseClaim.target : undefined,
    resolveReader() {
      operationAdmission.reader?.assertCurrent();
      return operationAdmission.reader;
    },
    resolveSessionTarget() {
      assertReaderOperation();
      operationAdmission.databaseClaim?.assertCurrent();
      return operationAdmission.sessionTarget;
    },
    acquireSessionActor() {
      assertReaderOperation();
      const claim = operationAdmission.databaseClaim;
      if (!claim || !("kind" in claim)) {
        throw new Error("Reply operation has no session actor admission");
      }
      sessionActor ??= claim
        .acquireSessionActor({
          assertCurrent: () => claim.assertCurrent(),
          assertReadable() {
            assertReaderOperation();
            claim.assertCurrent();
          },
        })
        .then((actor) => {
          operationAdmission.sessionActor = actor;
          return actor;
        });
      return sessionActor;
    },
    async afterTransition(transition) {
      assertTransitionActive();
      const current = operationAdmission.databaseClaim;
      const prepare =
        current && "kind" in current ? current.afterTransition?.bind(current) : undefined;
      if (!current || !prepare) {
        return;
      }
      handoff = (async () => {
        const next = await prepare(transition, assertTransitionActive);
        if (releasing) {
          await next.release();
          assertReaderOperation();
        }
        operationAdmission.databaseClaim = next;
        operationAdmission.reader = next.reader;
        operationAdmission.sessionTarget = next.target;
        // Revoke the old view synchronously, then join its accepted work before returning.
        try {
          await releaseSessionActor();
        } finally {
          await current.release();
        }
        assertTransitionActive();
      })();
      try {
        await handoff;
      } finally {
        handoff = undefined;
      }
    },
  };
  lifecycleAdmissionByOperation.set(operation, operationAdmission);
  const releaseWorkerDatabaseClaim =
    databaseClaim && "kind" in databaseClaim
      ? () => {
          if (!releasing) {
            const actorSettlement = sessionActor ? releaseSessionActor() : undefined;
            const settlement = actorSettlement
              ? undefined
              : operationAdmission.databaseClaim?.release();
            releasing = (async () => {
              await Promise.allSettled([handoff, settlement, actorSettlement]);
              if (settlement) {
                await settlement;
              } else {
                try {
                  await actorSettlement;
                } finally {
                  await operationAdmission.databaseClaim?.release();
                }
              }
            })();
          }
          return releasing;
        }
      : undefined;
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
