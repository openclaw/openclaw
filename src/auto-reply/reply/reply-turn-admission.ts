import { addAbortListener } from "node:events";
import { MAIN_SESSION_RECOVERY_WORK_ADMISSION_OWNER } from "../../agents/main-session-recovery/main-session-recovery-admission.js";
import { scheduleMainSessionRecoveryPendingTarget } from "../../agents/main-session-recovery/main-session-recovery-owner-release.js";
import { isMainSessionRecoveryIntentCurrent } from "../../agents/main-session-recovery/main-session-recovery-state.js";
import {
  claimMainSessionRecoveryOwner,
  type MainSessionRecoveryPendingTarget,
  type MainSessionRecoveryOwnerLease,
} from "../../agents/main-session-recovery/main-session-recovery-store.js";
import type {
  MainSessionRecoveryAuthorityHold,
  MainSessionRecoveryCurrentInput,
} from "../../agents/main-session-recovery/main-session-restart-dispatch.types.js";
import { isAgentRunRestartAbortReason } from "../../agents/run-termination.js";
import { beginForegroundSessionMaintenance } from "../../agents/session-maintenance/coordinator.js";
import {
  isRestartRecoveryTombstone,
  SessionWorkStartChangedError,
  resolveSessionWorkStartError,
} from "../../config/sessions/lifecycle.js";
import {
  hasMainSessionRecoveryClaim,
  isMainRestartRecoveryCandidate,
} from "../../config/sessions/restart-recovery-state.js";
import type { SessionAdmissionDatabaseClaim } from "../../config/sessions/session-accessor.sqlite-entry-admission.js";
import { loadSessionEntryForAdmission } from "../../config/sessions/session-accessor.sqlite-entry.js";
import { normalizeStoreSessionKey } from "../../config/sessions/store-entry.js";
import type { InternalSessionEntry } from "../../config/sessions/types.js";
import type { GatewayRecoveryRuntime } from "../../gateway/server-instance-runtime.types.js";
import type { GatewayContextResolver } from "../../gateway/server-methods/types.js";
import { racePromiseWithAbortSignal } from "../../infra/abort-signal.js";
import { getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  bindGatewayContextResolver,
  getGatewayContextResolver,
  getPluginRuntimeGatewayRequestScope,
  withPluginRuntimeGatewayContextResolver,
} from "../../plugins/runtime/gateway-request-scope.js";
import { parseAgentSessionKey } from "../../routing/session-key.js";
import {
  beginSessionWorkAdmission,
  getSessionWorkAdmissionOwnerRelease,
} from "../../sessions/session-lifecycle-admission.js";
import { getAsyncWorkSignal } from "../../shared/async-work-scope.js";
import {
  createReplyOperation,
  isReplyRunSuccessorAdmissionBlocked,
  REPLY_RUN_IDLE_SETTLE_TIMEOUT_MS,
  replyRunRegistry,
  ReplyRunAlreadyActiveError,
  ReplyRunFollowupAdmissionBlockedError,
  ReplyRunSuccessorAdmissionBlockedError,
  registerReplyOperationSuccessorBarrier,
  retainReplyOperationUntilComplete,
  runAfterReplyOperationClear,
  type ReplyOperation,
  type ReplyTurnKind,
  waitForReplyRunFollowupAdmission,
  waitForReplyRunSuccessorAdmission,
} from "./reply-run-registry.js";
import {
  expireVisibleStaleOperation,
  getAttachedBackend,
  lifecycleAdmissionByOperation,
  resolveVisibleActiveWaitMs,
} from "./reply-run-registry.state.js";
import {
  QueuedFollowupLifecycleInvalidatedError,
  mayRetainActiveReplyAdmission,
  assertReplyAdmissionGeneration,
  observeReplyAdmissionBoundary,
  type ReplyTurnAdmission,
  rejectLifecycleInvalidatedWork,
} from "./reply-turn-admission-errors.js";
import {
  releaseReplyRecoveryOwner,
  prepareRestartRecoveryCurrentInputClaim,
  resolveRestartRecoveryForegroundDisposition,
  prepareForegroundRestartRecoveryWait,
} from "./reply-turn-recovery-wait.js";
import { createReplyTurnRotationEvidence } from "./reply-turn-rotation.js";

class ReplyOperationChangedDuringAdmissionError extends Error {}

const log = createSubsystemLogger("auto-reply/reply-turn-admission");

/** Runs owner work with its admission marked as the initiating lifecycle context. */
export async function runWithReplyOperationLifecycleAdmission<T>(
  operation: ReplyOperation,
  run: () => Promise<T>,
): Promise<T> {
  const admission = lifecycleAdmissionByOperation.get(operation)?.lease;
  if (admission) {
    return await admission.run(run);
  }
  const resolver = getGatewayContextResolver(operation);
  return await withPluginRuntimeGatewayContextResolver(resolver, run);
}

function isAbortSignalAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

type ReplyTurnAdmissionParams = {
  assertRequestCurrent?: () => void;
  providerReviewAcknowledgment?: import("../../sessions/provider-review.js").ProviderReviewAcknowledgment;
  agentId?: string;
  sessionKey: string;
  sessionId: string;
  expectedSessionId?: string;
  /** Observed predecessors, from oldest to newest. */
  expectedActiveOperations?: readonly ReplyOperation[];
  storePath?: string;
  kind: ReplyTurnKind;
  resetTriggered: boolean;
  allowRestartTombstoneParentFork?: boolean;
  allowRestartTombstoneReset?: boolean;
  routeThreadId?: string | number;
  originatingLeafEntryId?: string | null;
  /**
   * Move this already-held operation into sessionKey's run slot instead of
   * creating a new one. Used when a native command turn (admitted under its
   * slash source key) continues into a full agent turn on the target session.
   */
  adoptOperation?: ReplyOperation;
  upstreamAbortSignal?: AbortSignal;
  resolveGatewayContext?: GatewayContextResolver;
  waitTimeoutMs?: number;
  waitForActive?: boolean;
  retainLifecycleAdmissionOnActive?: boolean;
  onLifecycleInterrupt?: () => void;
};

export async function admitReplyTurn(
  params: ReplyTurnAdmissionParams,
): Promise<ReplyTurnAdmission> {
  const workSignal = getAsyncWorkSignal();
  const activeAtAdmission = replyRunRegistry.get(params.sessionKey);
  const releaseForeground =
    params.kind === "visible"
      ? await beginForegroundSessionMaintenance(params.sessionKey)
      : undefined;
  let foregroundTransferred = false;
  // Maintenance may finish after the observed reply rotates and clears its slot.
  let sessionId = activeAtAdmission?.result ? activeAtAdmission.sessionId : params.sessionId;
  const resolveGatewayContext = params.adoptOperation
    ? getGatewayContextResolver(params.adoptOperation)
    : Object.hasOwn(params, "resolveGatewayContext")
      ? params.resolveGatewayContext
      : getPluginRuntimeGatewayRequestScope()?.resolveGatewayContext;
  let expectedSessionId = params.expectedSessionId;
  const lifecycleGeneration = getAgentEventLifecycleGeneration();
  let recoveryDispatchOutcome: "deferred" | "failed" | MainSessionRecoveryAuthorityHold | undefined;
  let recoveryCurrentInput: MainSessionRecoveryCurrentInput | undefined;
  const rotations = createReplyTurnRotationEvidence({
    sessionKey: params.sessionKey,
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
  function rejectSessionChange(
    message = `Session "${params.sessionKey}" changed while starting work. Retry.`,
  ): never {
    rejectLifecycleInvalidatedWork({ kind: params.kind, message, transientSessionChange: true });
  }
  const assertDatabaseOwnerCurrent = (nextClaim?: SessionAdmissionDatabaseClaim) => {
    if (
      admittedDatabaseClaim &&
      (!admittedDatabaseClaim.isCurrent() ||
        (nextClaim && nextClaim.incarnation !== admittedDatabaseClaim.incarnation))
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
  const waitForRecovery = prepareForegroundRestartRecoveryWait(
    params,
    () => resolveGatewayContext?.()?.recoveryRuntime,
    assertRecoveryOwnerCurrent,
  );
  // Retries may release a lifecycle lease, but cannot replace the first physical
  // database owner after waiting for an active turn, delivery, or writer.
  try {
    while (true) {
      if (isAbortSignalAborted(params.upstreamAbortSignal)) {
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
      if (isReplyRunSuccessorAdmissionBlocked(params.sessionKey)) {
        if (params.kind === "heartbeat") {
          return { status: "skipped", reason: "active-run" };
        }
        const successorAdmission = await waitForReplyRunSuccessorAdmission(
          params.sessionKey,
          params.kind === "visible" ? null : waitTimeoutMs,
          { signal: params.upstreamAbortSignal },
        );
        if (!successorAdmission.settled) {
          return {
            status: "skipped",
            reason: isAbortSignalAborted(params.upstreamAbortSignal) ? "aborted" : "active-run",
          };
        }
        rotations.recordBarrierSources(successorAdmission.sources);
        continue;
      }
      const rotationObservation = params.storePath ? rotations.observeAdmission() : undefined;
      try {
        const storePath = params.storePath;
        let operation: ReplyOperation | undefined;
        let admittedSessionEntry: InternalSessionEntry | undefined;
        let recoveryOwnerLease: MainSessionRecoveryOwnerLease | undefined;
        let interruptedBeforeOperation = false;
        let recoveryClaimStarted = false;
        const admission = storePath
          ? await beginSessionWorkAdmission({
              scope: storePath,
              resolveGatewayContext,
              identities: [params.sessionKey],
              storeWriterIdentities:
                parseAgentSessionKey(params.sessionKey) &&
                normalizeStoreSessionKey(params.sessionKey) === params.sessionKey
                  ? [params.sessionKey]
                  : undefined,
              signal: params.upstreamAbortSignal,
              onInterrupt: () => {
                interruptedBeforeOperation = true;
                operation?.abortForRestart();
                params.onLifecycleInterrupt?.();
              },
              assertAllowed: async (signal) => {
                assertDatabaseOwnerCurrent();
                const assertCurrent = () => {
                  params.assertRequestCurrent?.();
                  assertDatabaseOwnerCurrent();
                  assertReplyAdmissionGeneration({
                    admitting,
                    interrupted: interruptedBeforeOperation,
                    expectedGeneration: lifecycleGeneration,
                    currentGeneration: getAgentEventLifecycleGeneration(),
                  });
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
                  },
                );
                if (
                  !admitting ||
                  interruptedBeforeOperation ||
                  params.upstreamAbortSignal?.aborted
                ) {
                  await current.databaseClaim.release();
                  throw new SessionWorkStartChangedError("Session changed during state admission.");
                }
                try {
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
                const archivedSessionError = resolveSessionWorkStartError(
                  params.sessionKey || sessionId,
                  currentEntry,
                  {
                    providerReviewAcknowledgment: params.providerReviewAcknowledgment,
                    allowRestartTombstoneReplacement:
                      (params.resetTriggered && params.allowRestartTombstoneReset === true) ||
                      params.allowRestartTombstoneParentFork === true,
                  },
                );
                if (archivedSessionError) {
                  const tombstone = currentEntry?.mainRestartRecovery?.tombstone;
                  if (params.kind === "visible" && tombstone) {
                    log.warn(`${archivedSessionError} Recovery reason: ${tombstone.reason}`);
                  }
                  rejectLifecycleInvalidatedWork({
                    kind: params.kind,
                    message: archivedSessionError,
                    restartRecoveryTombstone: isRestartRecoveryTombstone(currentEntry),
                  });
                }
                sessionId = currentEntry?.sessionId ?? sessionId;
              },
            })
          : undefined;
        try {
          if (isReplyRunSuccessorAdmissionBlocked(params.sessionKey)) {
            throw new ReplyRunSuccessorAdmissionBlockedError(params.sessionKey);
          }
          const mayWaitForRecoveryOwner =
            storePath && !params.resetTriggered && params.allowRestartTombstoneParentFork !== true;
          // The named admission is the authoritative process-local busy fact even
          // after startup recovery has cleared the durable aborted marker.
          const recoveryOwnerRelease = mayWaitForRecoveryOwner
            ? getSessionWorkAdmissionOwnerRelease({
                scope: storePath,
                identities: [params.sessionKey, sessionId],
                owner: MAIN_SESSION_RECOVERY_WORK_ADMISSION_OWNER,
              })
            : undefined;
          const shouldClaimRecoveryOwner =
            mayWaitForRecoveryOwner &&
            admittedSessionEntry &&
            ((hasMainSessionRecoveryClaim(admittedSessionEntry) &&
              admittedSessionEntry.abortedLastRun === true) ||
              (params.kind !== "heartbeat" &&
                admittedSessionEntry.restartRecoveryRuns !== undefined &&
                (admittedSessionEntry.mainRestartRecovery !== undefined ||
                  !replyRunRegistry.get(params.sessionKey))) ||
              admittedSessionEntry.mainRestartRecovery?.tombstone !== undefined) &&
            isMainRestartRecoveryCandidate(admittedSessionEntry, params.sessionKey);
          const gatewayContext = resolveGatewayContext?.();
          const recoveryRuntime = gatewayContext?.recoveryRuntime;
          const currentInput = recoveryCurrentInput;
          const assertCurrentInput = prepareRestartRecoveryCurrentInputClaim(
            currentInput,
            params.kind,
            () => admittedSessionEntry,
            params.assertRequestCurrent,
            rejectSessionChange,
          );
          assertCurrentInput?.();
          if (
            recoveryOwnerRelease &&
            (params.kind !== "visible" || admittedSessionEntry?.abortedLastRun === true)
          ) {
            admission?.release();
            if (params.kind === "heartbeat") {
              return { status: "skipped", reason: "active-run" };
            }
            await (params.kind === "visible"
              ? waitForRecovery(recoveryOwnerRelease)
              : racePromiseWithAbortSignal(recoveryOwnerRelease, params.upstreamAbortSignal));
            continue;
          }
          if (
            shouldClaimRecoveryOwner &&
            admittedSessionEntry?.abortedLastRun === true &&
            // Ineligible automatic recovery cannot settle a new visible input's
            // wait. Its foreground claim preserves the predecessor and Goal.
            (params.kind !== "visible" ||
              isMainSessionRecoveryIntentCurrent(admittedSessionEntry)) &&
            params.kind !== "heartbeat" &&
            gatewayContext &&
            recoveryRuntime &&
            !recoveryCurrentInput
          ) {
            // The interrupted turn owns its delivery claim. Resume it before the
            // new input enters ordinary queue selection; a foreground claim would
            // instead block recovery while this input rejects the old delivery claim.
            admission?.release();
            if (recoveryDispatchOutcome) {
              const disposition = resolveRestartRecoveryForegroundDisposition({
                outcome: recoveryDispatchOutcome,
                entry: admittedSessionEntry,
                kind: params.kind,
                sessionKey: params.sessionKey,
                assertRequestCurrent: params.assertRequestCurrent,
              });
              recoveryDispatchOutcome = undefined;
              if (disposition === "skip") {
                return { status: "skipped", reason: "active-run" };
              }
              if (disposition === "wait") {
                await waitForRecovery();
                continue;
              }
            }
            const { retryRestartAbortedMainSessionRecovery } =
              await import("../../agents/main-session-recovery/main-session-restart-recovery.js");
            assertRecoveryOwnerCurrent(recoveryRuntime, "starting");
            params.upstreamAbortSignal?.throwIfAborted();
            const recovery = await retryRestartAbortedMainSessionRecovery({
              agentId: params.agentId,
              cfg: gatewayContext.getRuntimeConfig(),
              expectedSessionId: sessionId,
              expectedRecoveryRunId: admittedSessionEntry.restartRecoveryDeliveryRunId,
              expectedRecoverySourceRunId: admittedSessionEntry.restartRecoveryDeliverySourceRunId,
              gatewayRuntime: recoveryRuntime,
              sessionKey: params.sessionKey,
              storePath,
            });
            assertRecoveryOwnerCurrent(recoveryRuntime, "starting");
            recoveryCurrentInput = recovery.currentInput;
            recoveryDispatchOutcome = recoveryCurrentInput
              ? undefined
              : (recovery.authorityHold ?? (recovery.failed > 0 ? "failed" : "deferred"));
            // Recovery may have completed or another owner may have won. Reload
            // the exact session and its live owner instead of using this snapshot.
            continue;
          }
          if (shouldClaimRecoveryOwner && recoveryOwnerRelease === undefined) {
            // A claim can durably clear recovery state. Once it starts, a later
            // preparation change must fail this admission instead of replaying it.
            recoveryClaimStarted = true;
            const ownerClaim = await claimMainSessionRecoveryOwner({
              assertCommitAllowed: assertCurrentInput,
              inputIntent: currentInput?.intent,
              lifecycleGeneration: getAgentEventLifecycleGeneration(),
              sessionId,
              target: { agentId: params.agentId, sessionKey: params.sessionKey, storePath },
            });
            if (ownerClaim.kind === "invalidated") {
              rejectSessionChange();
            }
            recoveryOwnerLease = ownerClaim.kind === "claimed" ? ownerClaim.lease : undefined;
            admittedSessionEntry = ownerClaim.entry;
            assertCurrentInput?.();
          }
          if (interruptedBeforeOperation || isAbortSignalAborted(params.upstreamAbortSignal)) {
            rejectSessionChange();
          }
          assertDatabaseOwnerCurrent();
          if (rotationObservation?.changed()) {
            if (recoveryClaimStarted) {
              rejectSessionChange();
            }
            // A predecessor can rotate after the final row read but before this handoff.
            // Reacquire the full admission; its session ID alone grants no authority.
            throw new ReplyOperationChangedDuringAdmissionError();
          }
          if (params.adoptOperation) {
            // The dispatch closures own this object's abort/delivery lifecycle,
            // so the reservation must move rather than be recreated. Throws
            // ReplyRunAlreadyActiveError into the shared busy handling below.
            params.adoptOperation.updateSessionKey(params.sessionKey, params.agentId);
            operation = params.adoptOperation;
          } else {
            operation = createReplyOperation({
              sessionKey: params.sessionKey,
              sessionId,
              agentId: params.agentId,
              turnKind: params.kind,
              resetTriggered: params.resetTriggered,
              routeThreadId: params.routeThreadId,
              originatingLeafEntryId: params.originatingLeafEntryId,
              upstreamAbortSignal: params.upstreamAbortSignal,
              respectFollowupAdmissionBarrier:
                params.kind === "queued_followup" || params.kind === "heartbeat",
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
            params.retainLifecycleAdmissionOnActive &&
            mayRetainActiveReplyAdmission(params.kind, replyRunRegistry.get(params.sessionKey))
          ) {
            void admission.released.then(() => {
              scheduleMainSessionRecoveryPendingTarget(pendingRecovery);
            });
            return {
              status: "skipped",
              reason: "active-run",
              activeOperation: replyRunRegistry.get(params.sessionKey),
              ...(admittedSessionEntry ? { sessionEntry: admittedSessionEntry } : {}),
              lifecycleAdmission: admission,
            };
          }
          admission?.release();
          scheduleMainSessionRecoveryPendingTarget(pendingRecovery);
          throw error;
        }
        const operationAdmission = {
          lease: admission,
          databaseIdentity: admittedDatabaseClaim?.identity,
        };
        lifecycleAdmissionByOperation.set(operation, operationAdmission);
        const databaseClaim = admittedDatabaseClaim;
        const releaseWorkerDatabaseClaim =
          databaseClaim && "kind" in databaseClaim ? () => databaseClaim.release() : undefined;
        if (releaseWorkerDatabaseClaim) {
          const admittedOperation = operation;
          let releasingForRestart = false;
          const releaseForRestart = (signal: AbortSignal) => {
            if (releasingForRestart || !isAgentRunRestartAbortReason(signal.reason)) {
              return;
            }
            releasingForRestart = true;
            const runId = getAttachedBackend(admittedOperation)?.runId ?? "unbound";
            // Admission's read has settled; model/tool finalization owns no native work here.
            void releaseWorkerDatabaseClaim().then(
              () =>
                log.info(
                  `lease released: reason=restart-abort runId=${runId} kind=reply-admission`,
                  { sessionId },
                ),
              (error: unknown) =>
                log.warn(
                  `failed to release restart-aborted reply database owner: ${formatErrorMessage(error)}`,
                ),
            );
          };
          // Shutdown can cancel the owning work after terminal settlement freezes reply abort.
          const restartReleases = [...new Set([operation.abortSignal, workSignal])].flatMap(
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
            sessionKeys: [params.sessionKey],
            start: releaseWorkerDatabaseClaim,
            deferUntilClear: true,
          });
        }
        if (admission) {
          // The lifecycle fence follows hooks, media work, agent execution, and
          // final delivery. Reset/delete interrupts the operation and waits until
          // its actual owner clears it before mutating the persisted session.
          // Adoption rebinds the map to this target lease; the source-key lease
          // stays registered via its own after-clear callback (release is
          // idempotent), so both identities free on operation clear.
          retainReplyOperationUntilComplete(operation);
          let recoveryOwnerRelease:
            | Promise<MainSessionRecoveryPendingTarget | undefined>
            | undefined;
          const releaseRecoveryOwner = () =>
            (recoveryOwnerRelease ??= releaseReplyRecoveryOwner(recoveryOwnerLease));
          if (recoveryOwnerLease) {
            registerReplyOperationSuccessorBarrier({
              operation,
              sessionId: recoveryOwnerLease.sessionId,
              sessionKeys: [params.sessionKey, recoveryOwnerLease.sessionKey],
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
        if (releaseForeground) {
          foregroundTransferred = true;
          // Priority follows admission; optional jobs separately wait for real delivery.
          runAfterReplyOperationClear(operation, releaseForeground);
        }
        owned = true;
        return {
          status: "owned",
          operation,
          databaseClaim,
          ...(admittedSessionEntry ? { sessionEntry: admittedSessionEntry } : {}),
        };
      } catch (error) {
        if (isAbortSignalAborted(params.upstreamAbortSignal)) {
          return { status: "skipped", reason: "aborted" };
        }
        if (error instanceof QueuedFollowupLifecycleInvalidatedError) {
          return { status: "skipped", reason: "lifecycle-invalidated" };
        }
        if (error instanceof ReplyOperationChangedDuringAdmissionError) {
          continue;
        }
        if (error instanceof ReplyRunSuccessorAdmissionBlockedError) {
          if (params.kind === "heartbeat") {
            return { status: "skipped", reason: "active-run" };
          }
          continue;
        }
        if (error instanceof ReplyRunFollowupAdmissionBlockedError) {
          if (params.kind === "heartbeat") {
            return { status: "skipped", reason: "active-run" };
          }
          const followupAdmission = await waitForReplyRunFollowupAdmission(
            params.sessionKey,
            waitTimeoutMs ?? REPLY_RUN_IDLE_SETTLE_TIMEOUT_MS,
            { signal: params.upstreamAbortSignal },
          );
          if (!followupAdmission.settled) {
            return {
              status: "skipped",
              reason: isAbortSignalAborted(params.upstreamAbortSignal) ? "aborted" : "active-run",
            };
          }
          rotations.recordBarrierSources(followupAdmission.sources);
          continue;
        }
        if (!(error instanceof ReplyRunAlreadyActiveError)) {
          throw error;
        }
        const activeOperation = replyRunRegistry.get(params.sessionKey);
        if (params.kind === "visible" && activeOperation?.turnKind === "heartbeat") {
          // Background heartbeats must yield before queue policy can steer this
          // user turn into the heartbeat's model run and lose its visible reply.
          activeOperation.supersede();
        }
        if (params.kind === "visible" && expireVisibleStaleOperation(activeOperation)) {
          continue;
        }
        // Visible and queued turns may wait for active runs when waitForActive is set.
        if (
          params.kind === "heartbeat" ||
          (params.waitForActive === false &&
            mayRetainActiveReplyAdmission(params.kind, activeOperation))
        ) {
          return { status: "skipped", reason: "active-run", activeOperation };
        }
        if (!mayRetainActiveReplyAdmission(params.kind, activeOperation)) {
          observeReplyAdmissionBoundary(params.kind, "closing-predecessor-wait", activeOperation);
        }
        const activeWaitTimeoutMs =
          params.kind === "visible" ? resolveVisibleActiveWaitMs(activeOperation) : waitTimeoutMs;
        const activeDatabaseIdentity = activeOperation
          ? lifecycleAdmissionByOperation.get(activeOperation)?.databaseIdentity
          : undefined;
        const ended = await replyRunRegistry.waitForIdle(params.sessionKey, activeWaitTimeoutMs, {
          signal: params.upstreamAbortSignal,
        });
        if (!ended) {
          if (params.kind === "visible" && !isAbortSignalAborted(params.upstreamAbortSignal)) {
            // Visible turns block on active work like before, but in bounded wait
            // slices: each wake reclaims the owner once it is provably stale,
            // otherwise loops back to keep waiting.
            const latestActiveOperation = replyRunRegistry.get(params.sessionKey);
            expireVisibleStaleOperation(latestActiveOperation ?? activeOperation);
            continue;
          }
          return {
            status: "skipped",
            reason: isAbortSignalAborted(params.upstreamAbortSignal) ? "aborted" : "active-run",
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

export function resolveReplyTurnKind(opts?: { isHeartbeat?: boolean }): ReplyTurnKind {
  return opts?.isHeartbeat === true ? "heartbeat" : "visible";
}
