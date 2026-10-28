import { scheduleMainSessionRecoveryPendingTarget } from "../../agents/main-session-recovery/main-session-recovery-owner-release.js";
import {
  claimMainSessionRecoveryOwner,
  type MainSessionRecoveryOwnerLease,
} from "../../agents/main-session-recovery/main-session-recovery-store.js";
import { isAgentRunRestartAbortReason } from "../../agents/run-termination.js";
import { beginForegroundSessionMaintenance } from "../../agents/session-maintenance/coordinator.js";
import { captureAgentWorkspaceReadiness } from "../../agents/workspace-readiness.js";
import {
  isRestartRecoveryTombstone,
  SessionWorkStartChangedError,
} from "../../config/sessions/lifecycle.js";
import {
  hasMainSessionRecoveryClaim,
  isMainRestartRecoveryCandidate,
} from "../../config/sessions/restart-recovery-state.js";
import type { SessionAdmissionDatabaseClaim } from "../../config/sessions/session-accessor.sqlite-entry-admission.js";
import { loadSessionEntryForAdmission } from "../../config/sessions/session-accessor.sqlite-entry.js";
import { resolveSessionWorkStartBlock } from "../../config/sessions/session-work-start.js";
import { normalizeStoreSessionKey } from "../../config/sessions/store-entry.js";
import type { InternalSessionEntry } from "../../config/sessions/types.js";
import type { GatewayRecoveryRuntime } from "../../gateway/server-instance-runtime.types.js";
import { getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  bindGatewayContextResolver,
  getGatewayContextResolver,
  getPluginRuntimeGatewayRequestScope,
} from "../../plugins/runtime/gateway-request-scope.js";
import { CommandLane } from "../../process/lanes.js";
import { parseAgentSessionKey } from "../../routing/session-key.js";
import { evaluateTurnAdmission } from "../../sessions/session-controller.admission-rule.js";
import { ReplyRunLifecycleAdmissionBlockedError } from "../../sessions/session-controller.contracts.js";
import {
  createReplyOperation,
  hasCommittedReplyOperationOutcome,
  isReplyRunSuccessorAdmissionBlocked,
  REPLY_RUN_IDLE_SETTLE_TIMEOUT_MS,
  ReplyRunAlreadyActiveError,
  ReplyRunFollowupAdmissionBlockedError,
  ReplyRunSuccessorAdmissionBlockedError,
  runAfterReplyOperationClear,
  type ReplyOperation,
  waitForReplyRunFollowupAdmission,
  waitForSessionRunIdle,
} from "../../sessions/session-controller.js";
import {
  beginSessionEffect,
  captureSessionTarget,
} from "../../sessions/session-controller.lifecycle.js";
import {
  expireVisibleStaleOperation,
  isReplyOperationAbortedForRestart,
  lifecycleAdmissionByOperation,
  resolveVisibleActiveWaitMs,
  sessionControllers,
} from "../../sessions/session-controller.state.js";
import { getAsyncWorkSignal } from "../../shared/async-work-scope.js";
import {
  QueuedFollowupLifecycleInvalidatedError,
  rejectLifecycleInvalidatedWork,
} from "./reply-turn-admission-errors.js";
import {
  bindReplyAdmissionRelease,
  releaseReplyRecoveryOwner,
} from "./reply-turn-admission-lifecycle.js";
import { resolveReplyTurnController } from "./reply-turn-admission-target.js";
import { createReplyTurnAdmissionWaiter } from "./reply-turn-admission-wait.js";
import type { ReplyTurnAdmission, ReplyTurnAdmissionParams } from "./reply-turn-admission.types.js";
import {
  resolveReservedRestartResendId,
  retryRestartRecoveryBeforeSelectedClaim,
  yieldToInterruptedRestartResend,
} from "./reply-turn-recovery-predecessor.js";
import {
  reconcileOrWaitForReplyRecovery,
  waitForRestartRecoveryProgress,
} from "./reply-turn-recovery.js";
import { createReplyTurnRotationEvidence } from "./reply-turn-rotation.js";

export { runWithReplyOperationLifecycleAdmission } from "./reply-turn-admission-lifecycle.js";

class ReplyOperationChangedDuringAdmissionError extends Error {}

const log = createSubsystemLogger("auto-reply/reply-turn-admission");

function isAbortSignalAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

/** Waits for or claims the per-session reply run slot. */
export async function admitReplyTurn(
  params: ReplyTurnAdmissionParams,
): Promise<ReplyTurnAdmission> {
  const workspaceReadiness = captureAgentWorkspaceReadiness(params.sessionKey);
  const workSignal = getAsyncWorkSignal();
  const controller = resolveReplyTurnController(params);
  // Private registry identity is only a read/wait key. Logical keys still own
  // persistence, operation identity, and external routing.
  const controllerKey = controller.id;
  const waits = createReplyTurnAdmissionWaiter(controller, params);
  const activeAtAdmission = controller.active;
  const releaseForeground =
    params.kind === "visible"
      ? await beginForegroundSessionMaintenance(params.sessionKey)
      : undefined;
  let foregroundTransferred = false;
  // Maintenance may finish after the observed reply rotates and clears its slot.
  let sessionId =
    activeAtAdmission?.result &&
    !isReplyOperationAbortedForRestart(activeAtAdmission) &&
    ((!params.storePath && !params.expectedSessionId) ||
      activeAtAdmission.captureOwnedSessionIds().has(params.expectedSessionId ?? params.sessionId))
      ? activeAtAdmission.sessionId
      : params.sessionId;
  const resolveGatewayContext = params.adoptOperation
    ? getGatewayContextResolver(params.adoptOperation)
    : Object.hasOwn(params, "resolveGatewayContext")
      ? params.resolveGatewayContext
      : getPluginRuntimeGatewayRequestScope()?.resolveGatewayContext;
  let expectedSessionId = params.expectedSessionId;
  const lifecycleGeneration = getAgentEventLifecycleGeneration();
  let recoveryDispatchOutcome: "deferred" | "failed" | undefined;
  const rotations =
    params.rotationEvidence ??
    createReplyTurnRotationEvidence({
      sessionKey: params.sessionKey,
      controller,
      expectedActiveOperations: params.expectedActiveOperations,
      activeAtAdmission,
    });

  const waitTimeoutMs =
    params.waitTimeoutMs ??
    (params.kind === "queued_followup" ? REPLY_RUN_IDLE_SETTLE_TIMEOUT_MS : undefined);
  let admittedDatabaseClaim: SessionAdmissionDatabaseClaim | undefined;
  let discardedDatabaseClaimRelease: Promise<void> | undefined;
  let owned = false;
  let admitting = true;
  let inputWaitDeadline: number | undefined;
  function rejectSessionChange(
    message = `Session "${params.sessionKey}" changed while starting work. Retry.`,
  ): never {
    rejectLifecycleInvalidatedWork({ kind: params.kind, message, transientSessionChange: true });
  }
  const assertDatabaseOwnerCurrent = (nextClaim?: SessionAdmissionDatabaseClaim) => {
    if (
      (nextClaim &&
        params.expectedDatabaseIncarnation !== undefined &&
        nextClaim.incarnation !== params.expectedDatabaseIncarnation) ||
      (admittedDatabaseClaim &&
        (!admittedDatabaseClaim.isCurrent() ||
          (nextClaim && nextClaim.incarnation !== admittedDatabaseClaim.incarnation)))
    ) {
      const release = nextClaim?.release();
      if (release) {
        discardedDatabaseClaimRelease = release;
        // The synchronous assertion revokes now; the outer finally joins release.
        void release.catch(() => {});
      }
      rejectSessionChange(
        `Session store for "${params.sessionKey}" changed while starting work. Retry.`,
      );
    }
  };
  const assertRecoveryOwnerCurrent = (
    recoveryRuntime: GatewayRecoveryRuntime | undefined,
    action: "starting" | "waiting for",
  ) => {
    assertDatabaseOwnerCurrent();
    if (
      lifecycleGeneration !== getAgentEventLifecycleGeneration() ||
      resolveGatewayContext?.()?.recoveryRuntime !== recoveryRuntime
    ) {
      rejectSessionChange(
        `Session "${params.sessionKey}" changed while ${action} recovery. Retry.`,
      );
    }
  };
  const waitForRecovery = async () => {
    const recoveryRuntime = resolveGatewayContext?.()?.recoveryRuntime;
    await waitForRestartRecoveryProgress({
      agentId: params.agentId,
      sessionKey: params.sessionKey,
      signal: params.upstreamAbortSignal,
    });
    assertRecoveryOwnerCurrent(recoveryRuntime, "waiting for");
  };
  // Retries may release a lifecycle lease, but cannot replace the first physical
  // database owner after waiting for an active turn, delivery, or writer.
  try {
    while (true) {
      if (params.upstreamAbortSignal?.aborted) {
        return { status: "skipped", reason: "aborted" };
      }
      const storelessRotation = !params.storePath ? rotations.takeStorelessRotation() : undefined;
      if (storelessRotation) {
        if (expectedSessionId && !storelessRotation.sessionIds.has(expectedSessionId)) {
          return { status: "skipped", reason: "lifecycle-invalidated" };
        }
        sessionId = storelessRotation.sessionId;
        expectedSessionId = expectedSessionId ? storelessRotation.sessionId : undefined;
      }
      if (isReplyRunSuccessorAdmissionBlocked(controllerKey)) {
        const successorAdmission = await waits.barrier({
          phase: "successor-barrier",
          timeoutMs: params.kind === "visible" ? null : waitTimeoutMs,
          sessionId,
        });
        if (!successorAdmission.settled) {
          return {
            status: "skipped",
            reason: params.upstreamAbortSignal?.aborted ? "aborted" : "active-run",
          };
        }
        rotations.recordBarrierSources(successorAdmission.sources);
        continue;
      }
      const turnAdmission = evaluateTurnAdmission(controller, {
        kind: params.kind,
        sessionKey: params.sessionKey,
        registeredEntry: sessionControllers.get(controller.id),
        claim: params.mailboxClaim,
      });
      if (!turnAdmission.admitted && turnAdmission.reason === "followup-barrier") {
        // Pin the physical database before waiting on retained delivery custody.
        // This is a read claim, not turn admission or permission to write.
        if (params.storePath && !admittedDatabaseClaim) {
          const current = await loadSessionEntryForAdmission(
            {
              agentId: params.agentId,
              storePath: params.storePath,
              sessionKey: params.sessionKey,
              readConsistency: "latest",
            },
            {
              signal: params.upstreamAbortSignal,
              assertCurrent: () => params.assertRequestCurrent?.(),
            },
          );
          admittedDatabaseClaim = current.databaseClaim;
        }
        const settlement = await waits.barrier({
          phase: "followup-barrier",
          timeoutMs: waitTimeoutMs ?? REPLY_RUN_IDLE_SETTLE_TIMEOUT_MS,
          sessionId,
        });
        if (!settlement.settled) {
          return {
            status: "skipped",
            reason: isAbortSignalAborted(params.upstreamAbortSignal) ? "aborted" : "active-run",
          };
        }
        if (admittedDatabaseClaim && !admittedDatabaseClaim.isCurrent()) {
          return { status: "skipped", reason: "lifecycle-invalidated" };
        }
        rotations.recordBarrierSources(settlement.sources);
        continue;
      }
      if (!turnAdmission.admitted && turnAdmission.reason === "waiting-inputs") {
        if (params.waitForActive === false) {
          return { status: "skipped", reason: "active-run" };
        }
        if (params.kind !== "visible" && waitTimeoutMs !== undefined) {
          inputWaitDeadline ??= Date.now() + waitTimeoutMs;
        }
        const settled = await waits.inputs(inputWaitDeadline);
        if (!settled) {
          return {
            status: "skipped",
            reason: params.upstreamAbortSignal?.aborted ? "aborted" : "active-run",
          };
        }
        continue;
      }
      inputWaitDeadline = undefined;
      const rotationObservation = params.storePath ? rotations.observeAdmission() : undefined;
      try {
        const storePath = params.storePath;
        let operation: ReplyOperation | undefined;
        let admittedSessionEntry: InternalSessionEntry | undefined;
        let recoveryOwnerLease: MainSessionRecoveryOwnerLease | undefined;
        let interruptedBeforeOperation = false;
        let recoveryClaimStarted = false;
        const admission = storePath
          ? await beginSessionEffect({
              agentId: params.agentId,
              scope: storePath,
              isSettling: () =>
                operation !== undefined &&
                (operation.result !== null || hasCommittedReplyOperationOutcome(operation)),
              getAbortReason: () => operation?.abortSignal.reason,
              resolveGatewayContext,
              identities: [params.sessionKey],
              storeWriterIdentities:
                parseAgentSessionKey(params.sessionKey) &&
                normalizeStoreSessionKey(params.sessionKey) === params.sessionKey
                  ? [params.sessionKey]
                  : undefined,
              signal: params.upstreamAbortSignal,
              onInterrupt: (reason) => {
                interruptedBeforeOperation = true;
                if (isAgentRunRestartAbortReason(reason)) {
                  operation?.abortForRestart();
                } else {
                  operation?.abortByUser();
                }
                params.onLifecycleInterrupt?.();
              },
              assertAllowed: async (signal) => {
                assertDatabaseOwnerCurrent();
                const assertCurrent = () => {
                  params.assertRequestCurrent?.();
                  workspaceReadiness?.assertCurrent();
                  assertDatabaseOwnerCurrent();
                  if (
                    !admitting ||
                    interruptedBeforeOperation ||
                    lifecycleGeneration !== getAgentEventLifecycleGeneration()
                  ) {
                    throw new SessionWorkStartChangedError(
                      "Session changed while waiting for state admission.",
                    );
                  }
                };
                const current = await loadSessionEntryForAdmission(
                  {
                    agentId: params.agentId,
                    storePath,
                    sessionKey: params.sessionKey,
                    readConsistency: "latest",
                  },
                  {
                    signal,
                    assertCurrent,
                    onRegistryChange: params.onDatabaseRegistration,
                  },
                );
                try {
                  if (
                    !admitting ||
                    interruptedBeforeOperation ||
                    params.upstreamAbortSignal?.aborted
                  ) {
                    throw new SessionWorkStartChangedError(
                      "Session changed during state admission.",
                    );
                  }
                  params.assertRequestCurrent?.();
                } catch (error) {
                  await current.databaseClaim.release();
                  throw error;
                }
                assertDatabaseOwnerCurrent(current.databaseClaim);
                const previousDatabaseClaim = admittedDatabaseClaim;
                admittedDatabaseClaim = current.databaseClaim;
                await previousDatabaseClaim?.release();
                signal.throwIfAborted();
                assertCurrent();
                const currentEntry = current.entry;
                admittedSessionEntry = currentEntry;
                if (expectedSessionId && !currentEntry) {
                  rejectSessionChange(
                    `Session "${params.sessionKey}" was deleted while starting work. Retry.`,
                  );
                }
                rotationObservation?.recordCompletions();
                const activeOperationRotatedExpectedSession = rotations.hasExpectedSessionRotation({
                  expectedSessionId,
                  sessionId: currentEntry?.sessionId,
                  databaseIdentity: admittedDatabaseClaim?.identity,
                });
                if (
                  expectedSessionId &&
                  currentEntry?.sessionId !== expectedSessionId &&
                  !activeOperationRotatedExpectedSession
                ) {
                  rejectSessionChange();
                }
                if (activeOperationRotatedExpectedSession) {
                  expectedSessionId = currentEntry?.sessionId;
                }
                const archivedSessionError = resolveSessionWorkStartBlock(
                  params.sessionKey || sessionId,
                  currentEntry,
                  {
                    allowPendingWorkspace: workspaceReadiness ? true : undefined,
                    providerReviewAcknowledgment: params.providerReviewAcknowledgment,
                    allowRestartTombstoneReplacement:
                      (params.resetTriggered && params.allowRestartTombstoneReset === true) ||
                      params.allowRestartTombstoneParentFork === true,
                  },
                );
                if (archivedSessionError) {
                  const tombstone = currentEntry?.mainRestartRecovery?.tombstone;
                  if (params.kind === "visible" && tombstone) {
                    log.warn(
                      `${archivedSessionError.message} Recovery reason: ${tombstone.reason}`,
                    );
                  }
                  rejectLifecycleInvalidatedWork({
                    kind: params.kind,
                    message: archivedSessionError.message,
                    error: archivedSessionError,
                    restartRecoveryTombstone: isRestartRecoveryTombstone(currentEntry),
                  });
                }
                sessionId = currentEntry?.sessionId ?? sessionId;
                params.captureRunSelection?.();
              },
            })
          : undefined;
        try {
          if (isReplyRunSuccessorAdmissionBlocked(controllerKey)) {
            throw new ReplyRunSuccessorAdmissionBlockedError(params.sessionKey);
          }
          const shouldClaimRecoveryOwner =
            storePath &&
            !params.resetTriggered &&
            params.allowRestartTombstoneParentFork !== true &&
            admittedSessionEntry &&
            ((hasMainSessionRecoveryClaim(admittedSessionEntry) &&
              admittedSessionEntry.abortedLastRun === true) ||
              (admittedSessionEntry.restartRecoveryRuns !== undefined &&
                (admittedSessionEntry.mainRestartRecovery !== undefined || !controller.active)) ||
              admittedSessionEntry.mainRestartRecovery?.tombstone !== undefined) &&
            isMainRestartRecoveryCandidate(admittedSessionEntry, params.sessionKey);
          const gatewayContext = resolveGatewayContext?.();
          const recoveryRuntime = gatewayContext?.recoveryRuntime;
          if (
            shouldClaimRecoveryOwner &&
            (await yieldToInterruptedRestartResend({
              claim: params.mailboxClaim,
              entry: admittedSessionEntry,
              recoveryAdmissionRunId: params.recoveryAdmissionRunId,
              mailbox: controller.mailbox,
              releaseAdmission: () => admission?.release(),
              target: { agentId: params.agentId, sessionKey: params.sessionKey, storePath },
              waitForRecovery,
            }))
          ) {
            continue;
          }
          if (
            shouldClaimRecoveryOwner &&
            admittedSessionEntry?.abortedLastRun === true &&
            !admittedSessionEntry.mainRestartRecovery?.tombstone &&
            gatewayContext &&
            recoveryRuntime
          ) {
            // The interrupted turn owns its delivery claim. Resume it before the
            // new input enters ordinary queue selection; a foreground claim would
            // instead block recovery while this input rejects the old delivery claim.
            admission?.release();
            if (recoveryDispatchOutcome) {
              if (params.kind === "queued_followup") {
                return { status: "skipped", reason: "active-run" };
              }
              if (recoveryDispatchOutcome === "failed") {
                throw new Error(`Restart recovery failed: ${params.sessionKey}. See Gateway logs.`);
              }
              await waitForRecovery();
              recoveryDispatchOutcome = undefined;
              continue;
            }
            assertRecoveryOwnerCurrent(recoveryRuntime, "starting");
            params.upstreamAbortSignal?.throwIfAborted();
            const recovery = await retryRestartRecoveryBeforeSelectedClaim({
              agentId: params.agentId,
              cfg: gatewayContext.getRuntimeConfig(),
              claim: params.mailboxClaim,
              expectedRecoveryRunId: admittedSessionEntry.restartRecoveryDeliveryRunId,
              expectedRecoverySourceRunId: admittedSessionEntry.restartRecoveryDeliverySourceRunId,
              gatewayRuntime: recoveryRuntime,
              lane: params.kind === "visible" ? CommandLane.Main : undefined,
              reservationId: resolveReservedRestartResendId(admittedSessionEntry),
              sessionId,
              sessionKey: params.sessionKey,
              storePath,
              upstreamAbortSignal: params.upstreamAbortSignal,
            });
            if (!recovery) {
              continue;
            }
            assertRecoveryOwnerCurrent(recoveryRuntime, "starting");
            recoveryDispatchOutcome = recovery.failed > 0 ? "failed" : "deferred";
            // Recovery may have completed or another owner may have won. Reload
            // the exact session and its live owner instead of using this snapshot.
            continue;
          }
          if (shouldClaimRecoveryOwner) {
            // A claim can durably clear recovery state. Once it starts, a later
            // preparation change must fail this admission instead of replaying it.
            recoveryClaimStarted = true;
            const ownerClaim = await claimMainSessionRecoveryOwner({
              lifecycleGeneration: getAgentEventLifecycleGeneration(),
              sessionId,
              target: { agentId: params.agentId, sessionKey: params.sessionKey, storePath },
            });
            if (ownerClaim.kind === "invalidated") {
              if (
                ownerClaim.reason === "recovery_pending" &&
                !params.adoptOperation &&
                gatewayContext?.recoveryRuntime
              ) {
                // Release our admission so recovery can reclaim an orphan.
                admission?.release();
                await reconcileOrWaitForReplyRecovery({
                  agentId: params.agentId,
                  sessionKey: params.sessionKey,
                  storePath,
                  entry: ownerClaim.entry,
                  claim: params.mailboxClaim,
                  gatewayContext,
                  signal: params.upstreamAbortSignal,
                  assertCurrent: () => {
                    params.upstreamAbortSignal?.throwIfAborted();
                    params.assertRequestCurrent?.();
                    workspaceReadiness?.assertCurrent();
                    assertDatabaseOwnerCurrent();
                    if (lifecycleGeneration !== getAgentEventLifecycleGeneration()) {
                      rejectSessionChange();
                    }
                  },
                });
                continue;
              }
              rejectSessionChange();
            }
            recoveryOwnerLease = ownerClaim.kind === "claimed" ? ownerClaim.lease : undefined;
            admittedSessionEntry = ownerClaim.entry;
          }
          if (interruptedBeforeOperation || params.upstreamAbortSignal?.aborted) {
            rejectSessionChange();
          }
          assertDatabaseOwnerCurrent();
          if (rotationObservation?.changed()) {
            if (recoveryClaimStarted) {
              rejectSessionChange();
            }
            throw new ReplyOperationChangedDuringAdmissionError();
          }
          if (!storePath) {
            params.captureRunSelection?.();
          }
          if (params.adoptOperation) {
            // The dispatch closures own this object's abort/delivery lifecycle,
            // so the reservation must move rather than be recreated. Throws
            // ReplyRunAlreadyActiveError into the shared busy handling below.
            params.adoptOperation.updateSessionKey(
              params.sessionKey,
              params.agentId,
              params.mailboxClaim,
            );
            operation = params.adoptOperation;
          } else {
            operation = createReplyOperation({
              mailboxClaim: params.mailboxClaim,
              target: params.storePath
                ? captureSessionTarget({
                    storeScope: params.storePath,
                    sessionKey: params.sessionKey,
                    incarnation: sessionId,
                    agentId: params.agentId,
                  })
                : undefined,
              sessionKey: params.sessionKey,
              sessionId,
              agentId: params.agentId,
              turnKind: params.kind,
              resetTriggered: params.resetTriggered,
              routeThreadId: params.routeThreadId,
              originatingLeafEntryId: params.originatingLeafEntryId,
              upstreamAbortSignal: params.upstreamAbortSignal,
            });
            bindGatewayContextResolver(operation, resolveGatewayContext);
          }
        } catch (error) {
          const pendingRecovery = recoveryOwnerLease
            ? await releaseReplyRecoveryOwner(recoveryOwnerLease)
            : undefined;
          if (
            error instanceof ReplyRunAlreadyActiveError &&
            admission &&
            params.retainLifecycleAdmissionOnActive
          ) {
            void admission.released.then(() => {
              scheduleMainSessionRecoveryPendingTarget(pendingRecovery);
            });
            return {
              status: "skipped",
              reason: "active-run",
              activeOperation: controller.active,
              ...(admittedSessionEntry ? { sessionEntry: admittedSessionEntry } : {}),
              lifecycleAdmission: admission,
            };
          }
          admission?.release();
          scheduleMainSessionRecoveryPendingTarget(pendingRecovery);
          throw error instanceof ReplyRunLifecycleAdmissionBlockedError
            ? new ReplyRunLifecycleAdmissionBlockedError(
                params.sessionKey,
                admittedDatabaseClaim?.incarnation,
              )
            : error;
        }
        const databaseClaim = admittedDatabaseClaim;
        bindReplyAdmissionRelease({
          operation,
          admission,
          databaseClaim,
          recoveryOwnerLease,
          sessionId,
          sessionKey: params.sessionKey,
          workSignal,
        });
        if (releaseForeground) {
          foregroundTransferred = true;
          // Priority follows admission; optional jobs separately wait for real delivery.
          runAfterReplyOperationClear(operation, releaseForeground);
        }
        owned = true;
        return {
          status: "owned",
          operation,
          databaseClaim: admittedDatabaseClaim,
          ...(admittedSessionEntry ? { sessionEntry: admittedSessionEntry } : {}),
        };
      } catch (error) {
        if (params.upstreamAbortSignal?.aborted) {
          return { status: "skipped", reason: "aborted" };
        }
        if (error instanceof QueuedFollowupLifecycleInvalidatedError) {
          return { status: "skipped", reason: "lifecycle-invalidated", error: error.cause };
        }
        if (error instanceof ReplyOperationChangedDuringAdmissionError) {
          if (!rotations.hasCurrentRotationEvidence()) {
            rejectLifecycleInvalidatedWork({
              kind: params.kind,
              message: `Session "${params.sessionKey}" changed while starting work. Retry.`,
              transientSessionChange: true,
            });
          }
          continue;
        }
        if (error instanceof ReplyRunSuccessorAdmissionBlockedError) {
          continue;
        }
        if (error instanceof ReplyRunFollowupAdmissionBlockedError) {
          const followupAdmission = await waitForReplyRunFollowupAdmission(
            controllerKey,
            waitTimeoutMs ?? REPLY_RUN_IDLE_SETTLE_TIMEOUT_MS,
            { signal: params.upstreamAbortSignal },
          );
          if (!followupAdmission.settled) {
            return {
              status: "skipped",
              reason: params.upstreamAbortSignal?.aborted ? "aborted" : "active-run",
            };
          }
          rotations.recordBarrierSources(followupAdmission.sources);
          continue;
        }
        if (!(error instanceof ReplyRunAlreadyActiveError)) {
          throw error;
        }
        const activeOperation = controller.active;
        if (params.kind === "visible" && expireVisibleStaleOperation(activeOperation)) {
          continue;
        }
        // Visible and queued turns may wait for active runs when waitForActive is set.
        if (params.waitForActive === false) {
          return { status: "skipped", reason: "active-run", activeOperation };
        }
        const activeWaitTimeoutMs =
          params.kind === "visible" ? resolveVisibleActiveWaitMs(activeOperation) : waitTimeoutMs;
        const activeDatabaseIdentity = activeOperation
          ? lifecycleAdmissionByOperation.get(activeOperation)?.databaseIdentity
          : undefined;
        const ended = await waitForSessionRunIdle(controllerKey, activeWaitTimeoutMs, {
          signal: params.upstreamAbortSignal,
        });
        if (!ended) {
          if (params.kind === "visible" && !params.upstreamAbortSignal?.aborted) {
            // Visible turns block on active work like before, but in bounded wait
            // slices: each wake reclaims the owner once it is provably stale,
            // otherwise loops back to keep waiting.
            const latestActiveOperation = controller.active;
            expireVisibleStaleOperation(latestActiveOperation ?? activeOperation);
            continue;
          }
          return {
            status: "skipped",
            reason: params.upstreamAbortSignal?.aborted ? "aborted" : "active-run",
            activeOperation,
          };
        }
        if (activeOperation) {
          rotations.recordCompletedOperation(activeOperation, activeDatabaseIdentity);
        }
      } finally {
        rotationObservation?.dispose();
      }
    }
  } finally {
    admitting = false;
    if (!foregroundTransferred) {
      releaseForeground?.();
    }
    if (!owned) {
      try {
        await admittedDatabaseClaim?.release();
      } finally {
        await discardedDatabaseClaimRelease;
      }
    }
  }
}
