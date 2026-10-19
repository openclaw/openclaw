import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  createAgentRunDirectAbortError,
  createAgentRunRestartAbortError,
  createAgentRunSupersededAbortError as createSupersededError,
  isAgentRunRestartAbortReason,
  isAgentRunSupersededAbortReason,
} from "../agents/run-termination.js";
import type { ReplyFollowupAdmissionBarrierTimeoutPolicy } from "../auto-reply/reply/reply-dispatcher.types.js";
import type * as replyRunSettle from "../auto-reply/reply/reply-run-finalization-lease.js";
import { createAbortError } from "../infra/abort-signal.js";
import { getAgentEventLifecycleGeneration } from "../infra/agent-events.js";
import { markDiagnosticRunProgress } from "../logging/diagnostic-run-activity.js";
import { diagnosticLogger as diag } from "../logging/diagnostic-runtime.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  initialReplyOperationState,
  transitionReplyOperation,
  type ReplyOperationEvent,
  type ReplyOperationResult,
} from "./reply-operation-state.js";
import {
  flushReplyOperationAfterClear,
  registerFollowupAdmissionBarrier,
  startReplyOperationSuccessorBarriers,
  updateFollowupAdmissionSessionId,
  updateSuccessorAdmissionSessionId,
} from "./session-controller.barriers.js";
import {
  type ReplyBackendCancelReason,
  type ReplyOperation,
  sessionControllerOperationState,
  type SessionControllerOperation,
} from "./session-controller.contracts.js";
import { createReplyOperationExecutionCustody } from "./session-controller.execution-custody.js";
import {
  releaseSessionControllerOperation,
  bindSessionControllerTarget,
  captureSessionTarget,
} from "./session-controller.lifecycle.js";
import {
  prepareReplyOperationAdmission,
  installReplyOperationAdmission,
  adoptReplyOperationController,
  type CreateReplyOperationParams,
} from "./session-controller.operation-admission.js";
import { createReplyOperationRecovery } from "./session-controller.operation-recovery.js";
import {
  clearReplyRunState,
  evictReplyOperationByOperation,
  getAttachedBackend,
  isReplyOperationAbortable,
  addSessionControllerEntryAlias,
  operationsByUpstreamAbortSignal,
  producerCompletionByOperation,
  prepareReplyRunKeyUpdate,
  recordOperationBackendRunId,
  getSessionControllerEntry,
  resolveReplyOperationAgentId,
  runAfterReplyOperationClear,
} from "./session-controller.state.js";
import { backendReadyByOperation } from "./session-controller.storage.js";
import { createTerminalProducerFenceRegistry } from "./session-controller.terminal-producer-fences.js";
import { createReplyOperationToolAuthority } from "./session-controller.tool-authority.js";
import {
  createSessionControllerWatchdog,
  type SessionWatchdogWait,
} from "./session-controller.watchdog.js";

type ReplyOperationAbortCode = Extract<ReplyOperationResult, { kind: "aborted" }>["code"];

export function createReplyOperation(params: CreateReplyOperationParams): ReplyOperation {
  const admitted = prepareReplyOperationAdmission(params);
  const { sessionKey, sessionId } = admitted;
  let owner = admitted.owner;
  const controller = new AbortController();
  // Mutable for rekey adoption; closures must read this, never params.sessionKey.
  let currentSessionKey = sessionKey;
  let currentSessionId = sessionId;
  let currentAgentId = resolveReplyOperationAgentId(
    sessionKey,
    params.agentId ?? admitted.owner.target?.agentId,
  );
  let state = initialReplyOperationState();
  const completedResult = { kind: "completed" } as const;
  let staleExpiryReason: replyRunSettle.ReplyOperationStaleReason | undefined;
  let terminalRecovery = false;
  let acceptedSteeredInboundAudio = false;
  let sourceReplyDelivered = false;
  // A recorded yield ends the turn's work before settlement records it as the result.
  const ended = () => state.result !== null || state.phase === "yielded";
  const settledResult = (): ReplyOperationResult =>
    state.phase === "yielded" ? { kind: "yielded" } : { kind: "completed" };
  const toolAuthority = createReplyOperationToolAuthority({
    isOpen: () => !ended(),
    readOperation: () => operation,
    readOwner: () => owner,
  });
  let backendReady = createDeferredCore();
  const notifyBackendReady = () => {
    if (state.phase === "running" && owner.attachment?.backend) {
      backendReady.resolve();
    }
  };
  const ownerSettlement = createDeferredCore();
  const producerCompletion = createDeferredCore<unknown>();
  let producerError: unknown;
  const executionCustody = createReplyOperationExecutionCustody();
  let completionTimeout: number | ReplyFollowupAdmissionBarrierTimeoutPolicy | undefined;
  let ownerCompletionBarrier: Promise<void> | undefined;
  let ownerSettled = false;
  let installed = false;
  let cleanupPreservesOutcome = false;
  const executionCleanups = new Set<() => Promise<void>>();
  const terminalProducerFences = createTerminalProducerFenceRegistry(() => ownerSettled);
  let phaseWait: SessionWatchdogWait | undefined;
  const finishOwner = () => {
    if (ownerSettled) {
      return;
    }
    ownerSettled = true;
    watchdog.close();
    ownerSettlement.resolve(undefined);
    releaseSessionControllerOperation(operation);
  };
  const settleOwner = (): void => {
    const pending = ownerCompletionBarrier;
    if (!pending) {
      finishOwner();
      return;
    }
    void pending.then(() => {
      if (pending !== ownerCompletionBarrier) {
        settleOwner();
        return;
      }
      finishOwner();
    });
  };
  const startedAtMs = Date.now();
  const lifecycleGeneration = getAgentEventLifecycleGeneration();
  let lastActivityAtMs = startedAtMs;
  const upstreamAbortSignal = params.upstreamAbortSignal;
  let upstreamAbortHandler: (() => void) | undefined;
  const detachUpstreamAbort = () => {
    if (!upstreamAbortHandler) {
      return;
    }
    upstreamAbortSignal?.removeEventListener("abort", upstreamAbortHandler);
    upstreamAbortHandler = undefined;
  };
  const ownedSessionIds = new Set([sessionId]);
  const recordActivity = () => {
    lastActivityAtMs = Date.now();
    watchdog.progress("transport");
  };

  const markProgress = (reason: string) => {
    // Phase observations must not renew the semantic-stall deadline.
    watchdog.progress("transport", reason);
    markDiagnosticRunProgress({
      sessionId: currentSessionId,
      sessionKey: currentSessionKey,
      reason,
    });
  };

  const apply = (event: ReplyOperationEvent) => {
    const transition = transitionReplyOperation(state, event);
    state = transition.state;
    notifyBackendReady();
    for (const effect of transition.effects) {
      if (effect === "activity") {
        recordActivity();
      } else {
        const reasons = {
          "maintenance-wait": "deferred_maintenance:waiting",
          "maintenance-ready": "deferred_maintenance:wait_ended",
          "lane-wait": "global_lane:waiting",
          "lane-ready": "global_lane:wait_ended",
        };
        phaseWait?.close();
        phaseWait = undefined;
        if (effect === "maintenance-wait" || effect === "lane-wait") {
          const phase = state.phase;
          phaseWait = watchdog.beginWait({
            kind: effect === "maintenance-wait" ? "deferred_maintenance" : "global_capacity",
            isCurrent: () => owner.active === operation && !state.result && state.phase === phase,
          });
        } else {
          watchdog.progress("semantic", reasons[effect]);
        }
        markProgress(reasons[effect]);
      }
    }
  };
  const setResult = (result: ReplyOperationResult) => {
    backendReady.resolve();
    apply({ type: "result", result });
    toolAuthority.close();
    phaseWait?.close();
    watchdog.beginTerminal();
  };

  const clearState = (
    afterClearBarrier?: PromiseLike<unknown>,
    followupAdmissionBarrierTimeout?: number | ReplyFollowupAdmissionBarrierTimeoutPolicy,
  ) => {
    if (state.cleared) {
      return;
    }
    backendReady.resolve();
    apply({ type: "clear" });
    toolAuthority.close();
    phaseWait?.close();
    evictReplyOperationByOperation.delete(operation);
    detachUpstreamAbort();
    const registeredBarrier = afterClearBarrier
      ? registerFollowupAdmissionBarrier(
          operation,
          afterClearBarrier,
          followupAdmissionBarrierTimeout,
        )
      : undefined;
    updateFollowupAdmissionSessionId(operation);
    // Start owner handoff before waking a successor that could snapshot state it mutates.
    startReplyOperationSuccessorBarriers(operation);
    markProgress("reply_operation:ended");
    clearReplyRunState({
      sessionKey: currentSessionKey,
      sessionId: currentSessionId,
      operation,
    });
    if (!registeredBarrier) {
      flushReplyOperationAfterClear(operation, currentSessionId);
      return;
    }
    void registeredBarrier.settled.then(() =>
      flushReplyOperationAfterClear(operation, registeredBarrier.source.sessionId),
    );
  };

  const { retireAdmissionAfterFencing, expireOwner, forceCleanup } = createReplyOperationRecovery({
    readOperation: () => operation,
    readOwner: () => owner,
    hasEnded: ended,
    isOwnerSettled: () => ownerSettled,
    executionCleanups,
    revokeTerminalProducerFences: (isCurrent, options) =>
      terminalProducerFences.revokeAll(isCurrent, options),
    preserveCleanupOutcome: () => {
      cleanupPreservesOutcome ||= state.abortFrozen && !state.result;
    },
    settleResult: () => {
      if (!state.result) {
        setResult(settledResult());
      }
    },
    clearState,
    closeWatchdog: () => watchdog.close(),
    detachUpstreamAbort,
    settleOwner,
  });

  const complete = (
    barrier?: PromiseLike<unknown>,
    timeoutMs?: number | ReplyFollowupAdmissionBarrierTimeoutPolicy,
  ) => {
    if (barrier) {
      completionTimeout = timeoutMs;
      const completed = Promise.resolve(barrier).then(
        () => {},
        () => {},
      );
      ownerCompletionBarrier = ownerCompletionBarrier
        ? Promise.all([ownerCompletionBarrier, completed]).then(() => {})
        : completed;
    }
    executionCustody.completeWhenReleased(() => {
      producerCompletion.resolve(producerError);
      if (!state.result) {
        setResult(settledResult());
      }
      clearState(ownerCompletionBarrier, completionTimeout);
      settleOwner();
    });
  };

  const abortInternally = (reason?: unknown) => {
    if (!controller.signal.aborted) {
      controller.abort(reason);
    }
  };

  const watchdog = createSessionControllerWatchdog({
    startedAtMs,
    // Exact custody survives rekey and rotation; never rediscover the owner through its slot.
    isCurrent: () => installed && !ownerSettled,
    readPhase: () =>
      ownerSettled ? "settled" : ended() ? "terminal" : state.abortFrozen ? "finishing" : "active",
    requestStop: (effect) => expireOwner(effect, false),
    expireCleanup: (effect) => expireOwner(effect, true),
    onWarning: (decision) =>
      diag.warn(
        `reply watchdog: sessionKey=${currentSessionKey} action=${decision.action} reason=${decision.reason}`,
      ),
  });

  const abortOperation = (
    reason: ReplyBackendCancelReason,
    abortReason: unknown,
    abortedCode: ReplyOperationAbortCode,
  ) => {
    const backend = getAttachedBackend(operation);
    if (!state.result) {
      setResult({ kind: "aborted", code: abortedCode });
      detachUpstreamAbort();
    }
    abortInternally(abortReason);
    // Cancellation may throw. Only actual producer completion releases custody.
    try {
      backend?.cancel(reason);
    } finally {
      watchdog.beginTerminal();
    }
  };
  // Agent-run abort codes on the reason select the cancel reason and result code.
  const abortWithReason = (reason: unknown) => {
    const restart = isAgentRunRestartAbortReason(reason);
    const superseded = isAgentRunSupersededAbortReason(reason);
    abortOperation(
      restart ? "restart" : superseded ? "superseded" : "user_abort",
      reason,
      restart ? "aborted_for_restart" : superseded ? "aborted_for_supersession" : "aborted_by_user",
    );
  };
  const abortIfAbortable = (reason: () => unknown) => {
    if (!isReplyOperationAbortable(operation)) {
      return false;
    }
    abortWithReason(reason());
    return true;
  };

  const operation: SessionControllerOperation = {
    [sessionControllerOperationState]: {
      get phase() {
        return state.phase;
      },
      turnKind: params.turnKind ?? "visible",
      retireAdmissionAfterFencing,
      forceCleanup,
      registerTerminalProducerFence: (fence) => terminalProducerFences.register(fence),
      bindAttemptToolAuthoritySnapshot: (snapshot) => toolAuthority.bindAttemptSnapshot(snapshot),
    },
    get key() {
      return currentSessionKey;
    },
    get sessionId() {
      return currentSessionId;
    },
    get agentId() {
      return currentAgentId;
    },
    turnKind: params.turnKind === "direct" ? "visible" : (params.turnKind ?? "visible"),
    lifecycleGeneration,
    get routeThreadId() {
      return params.routeThreadId;
    },
    get originatingLeafEntryId() {
      return params.originatingLeafEntryId;
    },
    abortSignal: controller.signal,
    watchdog,
    get resetTriggered() {
      return params.resetTriggered;
    },
    get terminalRecovery() {
      return terminalRecovery;
    },
    get acceptedSteeredInboundAudio() {
      return acceptedSteeredInboundAudio;
    },
    get sourceReplyDelivered() {
      return sourceReplyDelivered;
    },
    get toolAuthorityFingerprint() {
      return toolAuthority.toolAuthorityFingerprint;
    },
    get requesterPrincipalKey() {
      return toolAuthority.requesterPrincipalKey;
    },
    get personalToolParticipants() {
      return toolAuthority.personalToolParticipants;
    },
    get toolAuthorityRoute() {
      return toolAuthority.toolAuthorityRoute;
    },
    get requestedToolAuthorityRoute() {
      return toolAuthority.requestedToolAuthorityRoute;
    },
    get automaticFallbackRoute() {
      return toolAuthority.automaticFallbackRoute;
    },
    setAutomaticFallbackRoute: toolAuthority.setAutomaticFallbackRoute,
    get phase() {
      // The released SDK reports native yield as running until normal completion.
      return state.phase === "yielded" ? (state.result ? "completed" : "running") : state.phase;
    },
    get result() {
      return state.result?.kind === "yielded" ? completedResult : state.result;
    },
    get admissionRetired() {
      return state.cleared;
    },
    retireAdmissionAfterFencing,
    get abortFrozen() {
      return state.abortFrozen;
    },
    registerExecutionCleanup(cleanup) {
      if (ownerSettled) {
        throw new Error("Operation already settled");
      }
      executionCleanups.add(cleanup);
      return () => {
        executionCleanups.delete(cleanup);
      };
    },
    registerTerminalProducerFence: (fence) => terminalProducerFences.register(fence),
    get terminalProducerBlocked() {
      return terminalProducerFences.blocked;
    },
    get staleExpiryReason() {
      return staleExpiryReason;
    },
    get startedAtMs() {
      return startedAtMs;
    },
    get lastActivityAtMs() {
      return lastActivityAtMs;
    },
    hasOwnedSessionId(candidateSessionId) {
      const normalizedSessionId = normalizeOptionalString(candidateSessionId);
      return normalizedSessionId ? ownedSessionIds.has(normalizedSessionId) : false;
    },
    captureOwnedSessionIds() {
      return new Set(ownedSessionIds);
    },
    recordActivity,
    setPhase(phase) {
      apply({ type: "phase", phase });
    },
    markWaitingForDeferredMaintenance() {
      apply({ type: "maintenance-wait" });
    },
    markDeferredMaintenanceWaitEnded() {
      apply({ type: "maintenance-ready" });
    },
    markWaitingForGlobalLane() {
      apply({ type: "lane-wait" });
    },
    markGlobalLaneWaitEnded() {
      apply({ type: "lane-ready" });
    },
    markTerminalRecovery() {
      terminalRecovery = true;
    },
    markSteeredInputAccepted({ inboundAudio }) {
      acceptedSteeredInboundAudio ||= inboundAudio;
      sourceReplyDelivered = false;
    },
    markSourceReplyDelivered() {
      sourceReplyDelivered = true;
    },
    bindToolAuthoritySnapshot: toolAuthority.bindToolAuthoritySnapshot,
    bindToolAuthoritySnapshotAsync: toolAuthority.bindToolAuthoritySnapshotAsync,
    projectToolAuthorityFingerprint: toolAuthority.projectToolAuthorityFingerprint,
    projectToolAuthorityFingerprintAsync: toolAuthority.projectToolAuthorityFingerprintAsync,
    projectRequesterToolAuthorityFingerprint:
      toolAuthority.projectRequesterToolAuthorityFingerprint,
    projectRequesterToolAuthorityFingerprintAsync:
      toolAuthority.projectRequesterToolAuthorityFingerprintAsync,
    bindToolAuthorityRoute: toolAuthority.bindToolAuthorityRoute,
    bindToolAuthorityRouteAsync: toolAuthority.bindToolAuthorityRouteAsync,
    updateSessionId(nextSessionId) {
      if (state.result) {
        return;
      }
      const normalizedNextSessionId = normalizeOptionalString(nextSessionId);
      if (!normalizedNextSessionId || normalizedNextSessionId === currentSessionId) {
        return;
      }
      recordActivity();
      currentSessionId = normalizedNextSessionId;
      ownedSessionIds.add(currentSessionId);
      addSessionControllerEntryAlias(owner, currentSessionId);
      if (owner.target) {
        bindSessionControllerTarget(
          operation,
          captureSessionTarget({
            ...owner.target,
            aliases: [...owner.logicalAliases],
            incarnation: currentSessionId,
          }),
        );
      }
      updateFollowupAdmissionSessionId(operation);
      updateSuccessorAdmissionSessionId(operation, currentSessionId);
      markProgress("reply_operation:session_updated");
    },
    updateSessionKey(nextSessionKey, agentId, mailboxClaim) {
      const update = prepareReplyRunKeyUpdate(
        operation,
        nextSessionKey,
        agentId,
        state.cleared,
        mailboxClaim,
      );
      if (!update) {
        return;
      }
      recordActivity();
      currentAgentId = update.agentId;
      if (
        update.sessionKey === currentSessionKey &&
        (!mailboxClaim || mailboxClaim.mailbox.owner === owner)
      ) {
        return;
      }
      const previousOwner = owner;
      const capturedTarget = mailboxClaim?.mailbox.owner.target ?? owner.target;
      const target = capturedTarget
        ? captureSessionTarget({
            ...capturedTarget,
            sessionKey: update.sessionKey,
            agentId: update.agentId,
            aliases: mailboxClaim ? capturedTarget.aliases : [update.sessionKey],
            // A moved command selects the destination identity, not the source incarnation.
            incarnation: mailboxClaim ? capturedTarget.incarnation : undefined,
          })
        : undefined;
      const nextOwner =
        mailboxClaim?.mailbox.owner ?? getSessionControllerEntry(update.sessionKey, target);
      backendReady.resolve();
      backendReady = createDeferredCore();
      backendReadyByOperation.set(operation, backendReady.promise);
      currentSessionKey = update.sessionKey;
      owner = nextOwner;
      adoptReplyOperationController(operation, previousOwner, owner, target, mailboxClaim);
      markProgress("reply_operation:session_key_adopted");
    },
    attachBackend(handle) {
      if (state.result || state.cleared || owner.active !== operation) {
        handle.cancel(
          state.result?.kind === "aborted"
            ? state.result.code === "aborted_for_restart"
              ? "restart"
              : state.result.code === "aborted_for_supersession"
                ? "superseded"
                : "user_abort"
            : "superseded",
        );
        return;
      }
      recordActivity();
      toolAuthority.bindBackendFingerprint(handle.toolAuthorityFingerprint);
      recordOperationBackendRunId(operation, handle.runId);
      const backend = { handle };
      if (owner.attachment?.operation === operation) {
        owner.attachment.backend = backend;
      } else {
        owner.attachment = { operation, backend };
      }
      notifyBackendReady();
      if (controller.signal.aborted) {
        handle.cancel("superseded");
      }
    },
    detachBackend(handle) {
      if (owner.active === operation && owner.attachment?.backend?.handle === handle) {
        owner.attachment.backend = undefined;
        if (
          !("handle" in owner.attachment) &&
          owner.attachment.projectSessionActive === undefined
        ) {
          owner.attachment = undefined;
        }
      }
    },
    freezeAbort() {
      apply({ type: "freeze" });
      detachUpstreamAbort();
      watchdog.beginFinalization();
    },
    retainFailureUntilComplete() {
      // Published SDK opt-in; controller failures already retain custody until complete().
    },
    yield() {
      const before = state;
      apply({ type: "yield" });
      if (state === before) {
        return false;
      }
      toolAuthority.close();
      phaseWait?.close();
      watchdog.beginTerminal();
      return true;
    },
    ownerSettlement: ownerSettlement.promise,
    retainExecution: executionCustody.retain,
    complete: () => complete(),
    completeThen(afterClear) {
      runAfterReplyOperationClear(operation, afterClear);
      complete();
    },
    completeWithAfterClearBarrier: complete,
    fail(code, cause) {
      producerError ??= cause;
      if (cleanupPreservesOutcome && !state.result) {
        return;
      }
      apply({ type: "freeze" });
      detachUpstreamAbort();
      if (!state.result) {
        setResult({ kind: "failed", code, cause });
      }
    },
    abort: (reason) => abortIfAbortable(() => reason ?? createAgentRunDirectAbortError()),
    abortByUser: () => abortIfAbortable(createAgentRunDirectAbortError),
    abortForRestart: () => abortIfAbortable(createAgentRunRestartAbortError),
    abortForStall() {
      if (!isReplyOperationAbortable(operation)) {
        return false;
      }
      const backend = getAttachedBackend(operation);
      staleExpiryReason ??= "no_activity";
      apply({ type: "freeze" });
      setResult({ kind: "failed", code: "run_stalled" });
      detachUpstreamAbort();
      abortInternally(
        Object.assign(createAbortError("Reply operation stalled"), {
          code: "OPENCLAW_SESSION_WATCHDOG",
        }),
      );
      try {
        backend?.cancel("superseded");
      } finally {
        watchdog.beginTerminal();
      }
      return true;
    },
    supersede(beforeSupersede) {
      const abortFrozen = state.abortFrozen;
      if (
        state.result ||
        cleanupPreservesOutcome ||
        state.cleared ||
        (!abortFrozen && !isReplyOperationAbortable(operation))
      ) {
        return false;
      }
      beforeSupersede?.();
      if (abortFrozen) {
        setResult({ kind: "aborted", code: "aborted_for_supersession" });
        watchdog.beginTerminal();
        return true;
      }
      abortOperation("superseded", createSupersededError(), "aborted_for_supersession");
      return true;
    },
  };

  producerCompletionByOperation.set(operation, producerCompletion.promise);
  operationsByUpstreamAbortSignal.set(operation.abortSignal, operation);
  evictReplyOperationByOperation.set(operation, () => {
    if (state.cleared) {
      return;
    }
    if (!state.result) {
      setResult({ kind: "aborted", code: "aborted_for_restart" });
    }
    abortInternally(createAgentRunRestartAbortError());
    try {
      getAttachedBackend(operation)?.cancel("restart");
    } catch (error) {
      diag.warn(
        `reply run lifecycle eviction cancel failed: sessionKey=${currentSessionKey} error=${String(error)}`,
      );
      throw error;
    } finally {
      watchdog.beginTerminal();
    }
  });

  backendReadyByOperation.set(operation, backendReady.promise);
  installReplyOperationAdmission(operation, admitted, params.mailboxClaim);
  installed = true;
  watchdog.start();
  markProgress("reply_operation:queued");
  if (upstreamAbortSignal) {
    operationsByUpstreamAbortSignal.set(upstreamAbortSignal, operation);
    const abortFromUpstream = () => {
      if (!state.result) {
        abortWithReason(upstreamAbortSignal.reason);
      }
    };
    if (upstreamAbortSignal.aborted) {
      abortFromUpstream();
    } else {
      upstreamAbortSignal.addEventListener("abort", abortFromUpstream, { once: true });
      upstreamAbortHandler = abortFromUpstream;
    }
  }

  return operation;
}
