import { performance } from "node:perf_hooks";
import { MAIN_SESSION_RECOVERY_WORK_ADMISSION_OWNER } from "../../agents/main-session-recovery/main-session-recovery-admission.js";
import { scheduleMainSessionRecoveryPendingTarget } from "../../agents/main-session-recovery/main-session-recovery-owner-release.js";
import { isMainRestartRecoveryCandidate } from "../../agents/main-session-recovery/main-session-recovery-state.js";
import {
  claimMainSessionRecoveryOwner,
  releaseMainSessionRecoveryOwner,
  type MainSessionRecoveryPendingTarget,
  type MainSessionRecoveryOwnerLease,
} from "../../agents/main-session-recovery/main-session-recovery-store.js";
import { beginForegroundSessionMaintenance } from "../../agents/session-maintenance/coordinator.js";
// Decides whether an inbound turn may start, queue, or abort a reply run.
import {
  isRestartRecoveryTombstone,
  SessionWorkStartChangedError,
  resolveSessionWorkStartError,
  SESSION_RESTART_RECOVERY_TOMBSTONE_ERROR_CODE,
  SessionRestartRecoveryTombstoneError,
} from "../../config/sessions/lifecycle.js";
import { loadSessionEntryForAdmission } from "../../config/sessions/session-accessor.sqlite-entry.js";
import type { InternalSessionEntry, SessionEntry } from "../../config/sessions/types.js";
import type { GatewayRecoveryRuntime } from "../../gateway/server-instance-runtime.types.js";
import type { GatewayContextResolver } from "../../gateway/server-methods/types.js";
import { racePromiseWithAbortSignal } from "../../infra/abort-signal.js";
import { getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { emitAgentRunStatusEvent } from "../../infra/agent-run-status-events.js";
import { formatErrorMessage } from "../../infra/errors.js";
import {
  getDiagnosticSessionActivitySnapshot,
  resolveRunStaleThresholdMs,
} from "../../logging/diagnostic-run-activity.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  bindGatewayContextResolver,
  getGatewayContextResolver,
  getPluginRuntimeGatewayRequestScope,
  withPluginRuntimeGatewayContextResolver,
} from "../../plugins/runtime/gateway-request-scope.js";
import {
  beginSessionWorkAdmission,
  getSessionWorkAdmissionOwnerRelease,
  type SessionWorkAdmissionLease,
} from "../../sessions/session-lifecycle-admission.js";
import type { OpenClawAgentDatabaseClaim } from "../../state/openclaw-agent-db-identity.js";
import { OPENCLAW_SQLITE_BUSY_TIMEOUT_MS } from "../../state/openclaw-state-db-contract.js";
import {
  createReplyOperation,
  expireStaleReplyOperation,
  isReplyRunSuccessorAdmissionBlocked,
  isReplyRunEvidenceStale,
  REPLY_RUN_IDLE_SETTLE_TIMEOUT_MS,
  REPLY_RUN_TERMINAL_SETTLE_TIMEOUT_MS,
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
  isReplyRunRecoveryBlocked,
  lifecycleAdmissionByOperation,
} from "./reply-run-registry.state.js";
import { waitForRestartRecoveryProgress } from "./reply-turn-recovery-wait.js";
import { createReplyTurnRotationEvidence } from "./reply-turn-rotation.js";

/** Admission result for a reply turn attempting to own the session run slot. */
type ReplyTurnAdmission =
  | {
      status: "owned";
      operation: ReplyOperation;
      sessionEntry?: SessionEntry;
      databaseClaim?: OpenClawAgentDatabaseClaim;
    }
  | {
      status: "skipped";
      reason: "active-run" | "aborted" | "lifecycle-invalidated";
      activeOperation?: ReplyOperation;
      sessionEntry?: SessionEntry;
      lifecycleAdmission?: SessionWorkAdmissionLease;
    };

class QueuedFollowupLifecycleInvalidatedError extends Error {}

const log = createSubsystemLogger("auto-reply/reply-turn-admission");

async function releaseReplyRecoveryOwner(
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

function rejectLifecycleInvalidatedWork(params: {
  kind: ReplyTurnKind;
  message: string;
  restartRecoveryTombstone?: boolean;
  transientSessionChange?: boolean;
}): never {
  if (params.kind === "queued_followup") {
    const error = new QueuedFollowupLifecycleInvalidatedError(params.message);
    if (params.restartRecoveryTombstone === true) {
      Object.assign(error, { code: SESSION_RESTART_RECOVERY_TOMBSTONE_ERROR_CODE });
    }
    throw error;
  }
  if (params.restartRecoveryTombstone === true) {
    throw new SessionRestartRecoveryTombstoneError(params.message);
  }
  if (params.kind === "visible" && params.transientSessionChange === true) {
    throw new SessionWorkStartChangedError(params.message);
  }
  throw new Error(params.message);
}

function isAbortSignalAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function expireVisibleStaleOperation(operation: ReplyOperation | undefined): boolean {
  if (!operation) {
    return false;
  }
  const idleMs = Date.now() - operation.lastActivityAtMs;
  if (operation.result) {
    return (
      idleMs >= REPLY_RUN_TERMINAL_SETTLE_TIMEOUT_MS &&
      expireStaleReplyOperation(operation, "terminal_unreleased")
    );
  }
  return isReplyRunEvidenceStale(operation) && expireStaleReplyOperation(operation, "no_activity");
}

function resolveVisibleActiveWaitMs(operation: ReplyOperation | undefined): number {
  if (!operation || isReplyRunRecoveryBlocked(operation)) {
    return REPLY_RUN_IDLE_SETTLE_TIMEOUT_MS;
  }
  const ageMs = Date.now() - operation.lastActivityAtMs;
  const activity = getDiagnosticSessionActivitySnapshot({
    sessionId: operation.sessionId,
    sessionKey: operation.key,
  });
  const remainingMs = operation.result
    ? REPLY_RUN_TERMINAL_SETTLE_TIMEOUT_MS - ageMs
    : resolveRunStaleThresholdMs(activity, ageMs) - ageMs;
  return Math.min(REPLY_RUN_IDLE_SETTLE_TIMEOUT_MS, Math.max(1, remainingMs));
}

type ReplyTurnAdmissionParams = {
  runId?: string;
  stateAcquisitionDeadline?: () => number;
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

/** Waits for or claims the per-session reply run slot. */
export async function admitReplyTurn(
  params: ReplyTurnAdmissionParams,
): Promise<ReplyTurnAdmission> {
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
  let recoveryDispatchOutcome: "deferred" | "failed" | undefined;
  const rotations = createReplyTurnRotationEvidence({
    sessionKey: params.sessionKey,
    expectedActiveOperations: params.expectedActiveOperations,
    activeAtAdmission,
  });

  const waitTimeoutMs =
    params.waitTimeoutMs ??
    (params.kind === "queued_followup" ? REPLY_RUN_IDLE_SETTLE_TIMEOUT_MS : undefined);
  let acquisitionDeadlineMs: number | undefined;
  let admittedDatabaseClaim: OpenClawAgentDatabaseClaim | undefined;
  let owned = false;
  let admitting = true;
  const assertDatabaseOwnerCurrent = (nextClaim?: OpenClawAgentDatabaseClaim) => {
    if (
      admittedDatabaseClaim &&
      (!admittedDatabaseClaim.isCurrent() ||
        (nextClaim && nextClaim.incarnation !== admittedDatabaseClaim.incarnation))
    ) {
      nextClaim?.release();
      rejectLifecycleInvalidatedWork({
        kind: params.kind,
        message: `Session store for "${params.sessionKey}" changed while starting work. Retry.`,
        transientSessionChange: true,
      });
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
      rejectLifecycleInvalidatedWork({
        kind: params.kind,
        message: `Session "${params.sessionKey}" changed while ${action} recovery. Retry.`,
        transientSessionChange: true,
      });
    }
  };
  const waitForRecovery = async (ownerRelease?: Promise<void>) => {
    const recoveryRuntime = resolveGatewayContext?.()?.recoveryRuntime;
    await waitForRestartRecoveryProgress({
      agentId: params.agentId,
      sessionKey: params.sessionKey,
      ownerRelease,
      signal: params.upstreamAbortSignal,
    });
    assertRecoveryOwnerCurrent(recoveryRuntime, "waiting for");
  };
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
      try {
        const storePath = params.storePath;
        let operation: ReplyOperation | undefined;
        let admittedSessionEntry: InternalSessionEntry | undefined;
        let recoveryOwnerLease: MainSessionRecoveryOwnerLease | undefined;
        let interruptedBeforeOperation = false;
        const admission = storePath
          ? await beginSessionWorkAdmission({
              scope: storePath,
              resolveGatewayContext,
              identities: [params.sessionKey],
              signal: params.upstreamAbortSignal,
              onInterrupt: () => {
                interruptedBeforeOperation = true;
                operation?.abortForRestart();
                params.onLifecycleInterrupt?.();
              },
              assertAllowed: async (signal) => {
                assertDatabaseOwnerCurrent();
                const current = await loadSessionEntryForAdmission(
                  {
                    agentId: params.agentId,
                    storePath,
                    sessionKey: params.sessionKey,
                    readConsistency: "latest",
                  },
                  {
                    signal,
                    get deadlineMs() {
                      return (acquisitionDeadlineMs ??= Math.min(
                        params.stateAcquisitionDeadline?.() ?? Number.POSITIVE_INFINITY,
                        performance.now() + OPENCLAW_SQLITE_BUSY_TIMEOUT_MS,
                      ));
                    },
                    assertCurrent: () => {
                      params.assertRequestCurrent?.();
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
                    },
                    onWait: params.runId
                      ? () =>
                          emitAgentRunStatusEvent({
                            runId: params.runId!,
                            phase: "waiting_for_state",
                            sessionKey: params.sessionKey,
                            agentId: params.agentId,
                          })
                      : undefined,
                  },
                );
                if (
                  !admitting ||
                  interruptedBeforeOperation ||
                  params.upstreamAbortSignal?.aborted
                ) {
                  current.databaseClaim.release();
                  throw new SessionWorkStartChangedError("Session changed during state admission.");
                }
                try {
                  params.assertRequestCurrent?.();
                } catch (error) {
                  current.databaseClaim.release();
                  throw error;
                }
                assertDatabaseOwnerCurrent(current.databaseClaim);
                admittedDatabaseClaim?.release();
                admittedDatabaseClaim = current.databaseClaim;
                const currentEntry = current.entry;
                admittedSessionEntry = currentEntry;
                if (expectedSessionId && !currentEntry) {
                  rejectLifecycleInvalidatedWork({
                    kind: params.kind,
                    message: `Session "${params.sessionKey}" was deleted while starting work. Retry.`,
                    transientSessionChange: true,
                  });
                }
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
                  rejectLifecycleInvalidatedWork({
                    kind: params.kind,
                    message: `Session "${params.sessionKey}" changed while starting work. Retry.`,
                    transientSessionChange: true,
                  });
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
            ((admittedSessionEntry.status === "running" &&
              (admittedSessionEntry.abortedLastRun === true ||
                (params.kind !== "heartbeat" &&
                  admittedSessionEntry.restartRecoveryRuns !== undefined))) ||
              admittedSessionEntry.mainRestartRecovery?.tombstone !== undefined) &&
            isMainRestartRecoveryCandidate(admittedSessionEntry, params.sessionKey);
          const gatewayContext = resolveGatewayContext?.();
          const recoveryRuntime = gatewayContext?.recoveryRuntime;
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
            recoveryOwnerRelease === undefined &&
            admittedSessionEntry?.abortedLastRun === true &&
            !admittedSessionEntry.mainRestartRecovery?.tombstone &&
            params.kind !== "heartbeat" &&
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
            recoveryDispatchOutcome = recovery.failed > 0 ? "failed" : "deferred";
            // Recovery may have completed or another owner may have won. Reload
            // the exact session and its live owner instead of using this snapshot.
            continue;
          }
          if (shouldClaimRecoveryOwner && recoveryOwnerRelease === undefined) {
            const ownerClaim = await claimMainSessionRecoveryOwner({
              lifecycleGeneration: getAgentEventLifecycleGeneration(),
              sessionId,
              target: { agentId: params.agentId, sessionKey: params.sessionKey, storePath },
            });
            if (ownerClaim.kind === "invalidated") {
              rejectLifecycleInvalidatedWork({
                kind: params.kind,
                message: `Session "${params.sessionKey}" changed while starting work. Retry.`,
                transientSessionChange: true,
              });
            }
            recoveryOwnerLease = ownerClaim.kind === "claimed" ? ownerClaim.lease : undefined;
          }
          if (interruptedBeforeOperation || isAbortSignalAborted(params.upstreamAbortSignal)) {
            rejectLifecycleInvalidatedWork({
              kind: params.kind,
              message: `Session "${params.sessionKey}" changed while starting work. Retry.`,
              transientSessionChange: true,
            });
          }
          assertDatabaseOwnerCurrent();
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
            params.retainLifecycleAdmissionOnActive
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
            void releaseRecoveryOwner().then((pendingTarget) => {
              admission.release();
              scheduleMainSessionRecoveryPendingTarget(pendingTarget);
            });
          });
        }
        const databaseClaim = admittedDatabaseClaim;
        if (databaseClaim) {
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
        if (params.kind === "heartbeat") {
          return { status: "skipped", reason: "active-run", activeOperation };
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
      }
    }
  } finally {
    admitting = false;
    if (!foregroundTransferred) {
      releaseForeground?.();
    }
    if (!owned) {
      admittedDatabaseClaim?.release();
    }
  }
}

/** Resolves the default turn kind from reply options. */
export function resolveReplyTurnKind(opts?: { isHeartbeat?: boolean }): ReplyTurnKind {
  return opts?.isHeartbeat === true ? "heartbeat" : "visible";
}
