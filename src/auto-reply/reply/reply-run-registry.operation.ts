import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  createAgentRunDirectAbortError,
  createAgentRunRestartAbortError,
  createAgentRunSupersededAbortError as createSupersededError,
  isAgentRunRestartAbortReason,
  isAgentRunSupersededAbortReason,
} from "../../agents/run-termination.js";
import { createAbortError } from "../../infra/abort-signal.js";
import { getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { notifyGatewayWorkMetricsChanged } from "../../infra/gateway-work-metrics-events.js";
import { markDiagnosticRunProgress } from "../../logging/diagnostic-run-activity.js";
import { diagnosticLogger as diag } from "../../logging/diagnostic-runtime.js";
import { createDeferredCore } from "../../shared/deferred.js";
import type { ReplyFollowupAdmissionBarrierTimeoutPolicy } from "./reply-dispatcher.types.js";
import * as replyRunSettle from "./reply-run-finalization-lease.js";
import {
  REPLY_RUN_TERMINAL_SETTLE_TIMEOUT_MS,
  ReplyRunAlreadyActiveError,
  ReplyRunFollowupAdmissionBlockedError,
  ReplyRunSuccessorAdmissionBlockedError,
  type ReplyBackendCancelReason,
  type ReplyOperation,
  type ReplyOperationPhase,
  type ReplyTurnKind,
} from "./reply-run-registry.contracts.js";
import {
  abortFrozenOperations,
  attachedBackendByOperation,
  backendReadyByOperation,
  clearReplyOperationByOperation,
  clearReplyRunState,
  evictReplyOperationByOperation,
  expireReplyOperationByOperation,
  flushReplyOperationAfterClear,
  forceClearReplyOperation,
  getAttachedBackend,
  hasCommittedReplyOperationOutcome,
  isReplyOperationAbortable,
  isReplyOperationPreBackendPhase,
  notifyReplyRunEnded,
  operationsByUpstreamAbortSignal,
  producerCompletionByOperation,
  prepareReplyRunKeyUpdate,
  registerFollowupAdmissionBarrier,
  replyRunState,
  resolveReplyOperationAgentId,
  retainStateUntilCompleteOperations,
  type ReplyRunAdmissionBarrier,
  startReplyOperationSuccessorBarriers,
  updateFollowupAdmissionSessionId,
  updateSuccessorAdmissionSessionId,
} from "./reply-run-registry.state.js";
import { createReplyOperationToolAuthority } from "./reply-run-registry.tool-authority.js";

type ReplyOperationResult = NonNullable<ReplyOperation["result"]>;
const REPLY_OPERATION_ABORT_CODES = {
  user_abort: "aborted_by_user",
  restart: "aborted_for_restart",
  superseded: "aborted_for_supersession",
} as const;

export function createReplyOperation(params: {
  sessionKey: string;
  sessionId: string;
  agentId?: string;
  turnKind?: ReplyTurnKind;
  resetTriggered: boolean;
  routeThreadId?: string | number;
  originatingLeafEntryId?: string | null;
  upstreamAbortSignal?: AbortSignal;
  respectFollowupAdmissionBarrier?: boolean;
}): ReplyOperation {
  const sessionKey = normalizeOptionalString(params.sessionKey);
  const sessionId = normalizeOptionalString(params.sessionId);
  if (!sessionKey) {
    throw new Error("Reply operations require a canonical sessionKey");
  }
  if (!sessionId) {
    throw new Error("Reply operations require a sessionId");
  }
  if (
    params.respectFollowupAdmissionBarrier &&
    replyRunState.followupAdmissionBarriersByKey.has(sessionKey)
  ) {
    throw new ReplyRunFollowupAdmissionBlockedError(sessionKey);
  }
  if (replyRunState.activeRunsByKey.has(sessionKey)) {
    throw new ReplyRunAlreadyActiveError(sessionKey);
  }
  if (replyRunState.successorAdmissionBarriersByKey.has(sessionKey)) {
    throw new ReplyRunSuccessorAdmissionBlockedError(sessionKey);
  }

  const controller = new AbortController();
  // Mutable so updateSessionKey can move the run slot (command-turn continuation
  // adoption); every closure below must read this, never params.sessionKey.
  let currentSessionKey = sessionKey;
  let currentSessionId = sessionId;
  let currentAgentId = resolveReplyOperationAgentId(sessionKey, params.agentId);
  let phase: ReplyOperationPhase = "queued";
  let phaseBeforeGlobalLaneWait: "queued" | "running" | undefined;
  let staleExpiryReason: replyRunSettle.ReplyOperationStaleReason | undefined;
  let result: ReplyOperationResult | null = null;
  let stateCleared = false;
  let pendingClearBarrier: ReplyRunAdmissionBarrier | undefined;
  let retainFailureUntilComplete = false;
  let terminalRecovery = false;
  let acceptedSteeredInboundAudio = false;
  let sourceReplyDelivered = false;
  const toolAuthority = createReplyOperationToolAuthority({
    isOpen: () => result === null,
    ownsRunSlot: () => replyRunState.activeRunsByKey.get(currentSessionKey) === operation,
    captureCurrent: () => {
      const key = currentSessionKey;
      const id = currentSessionId;
      const backend = getAttachedBackend(operation);
      const assertCurrent = () => {
        if (
          result ||
          controller.signal.aborted ||
          currentSessionKey !== key ||
          currentSessionId !== id ||
          getAttachedBackend(operation) !== backend ||
          replyRunState.activeRunsByKey.get(key) !== operation ||
          getAgentEventLifecycleGeneration() !== lifecycleGeneration
        ) {
          throw new Error("Reply operation tool authority is no longer active");
        }
      };
      assertCurrent();
      return assertCurrent;
    },
  });
  const ownerSettlement = createDeferredCore();
  const producerCompletion = createDeferredCore<unknown>();
  let producerError: unknown;
  let backendReady = createDeferredCore();
  const notifyBackendReady = () => {
    if (phase === "running" && getAttachedBackend(operation)) {
      backendReady.resolve();
    }
  };
  let ownerCompletionBarrier: Promise<void> | undefined;
  const settleOwner = (): void => {
    const pending = ownerCompletionBarrier;
    if (!pending) {
      ownerSettlement.resolve(undefined);
      return;
    }
    void pending.then(() =>
      pending === ownerCompletionBarrier ? ownerSettlement.resolve(undefined) : settleOwner(),
    );
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
  };
  const setResult = (next: ReplyOperationResult) => {
    result = next;
    toolAuthority.close();
    recordActivity();
    phase = next.kind;
    backendReady.resolve();
    notifyGatewayWorkMetricsChanged();
  };
  const markProgress = (reason: string) => {
    markDiagnosticRunProgress({
      sessionId: currentSessionId,
      sessionKey: currentSessionKey,
      reason,
    });
  };
  const warnForcedRelease = (label: string, reason?: string) => {
    diag.warn(
      `reply run ${label}: forced release sessionKey=${currentSessionKey}${reason === undefined ? "" : ` reason=${reason}`} phase=${phase} result=${replyRunSettle.formatReplyOperationResult(
        result,
      )} ageMs=${Date.now() - lastActivityAtMs} ranForMs=${Date.now() - startedAtMs}`,
    );
  };

  const clearState = (
    afterClearBarrier?: PromiseLike<unknown>,
    followupAdmissionBarrierTimeout?: number | ReplyFollowupAdmissionBarrierTimeoutPolicy,
  ) => {
    if (stateCleared) {
      return;
    }
    stateCleared = true;
    backendReady.resolve();
    toolAuthority.close();
    terminalSettleTimer.clear();
    finalizationLease.clear();
    expireReplyOperationByOperation.delete(operation);
    evictReplyOperationByOperation.delete(operation);
    clearReplyOperationByOperation.delete(operation);
    detachUpstreamAbort();
    const registeredBarrier = afterClearBarrier
      ? registerFollowupAdmissionBarrier(
          operation,
          afterClearBarrier,
          followupAdmissionBarrierTimeout,
        )
      : pendingClearBarrier;
    pendingClearBarrier = undefined;
    updateFollowupAdmissionSessionId(operation);
    // Recovery-owner handoff must begin before the old slot wakes a successor;
    // otherwise that successor can snapshot durable state the handoff then mutates.
    startReplyOperationSuccessorBarriers(operation);
    markProgress("reply_operation:ended");
    clearReplyRunState(operation);
    if (!registeredBarrier) {
      flushReplyOperationAfterClear(operation, currentSessionId);
      return;
    }
    void registeredBarrier.settled.then(() =>
      flushReplyOperationAfterClear(operation, registeredBarrier.source.sessionId),
    );
  };

  const scheduleTerminalSettle = () => {
    if (stateCleared) {
      return;
    }
    terminalSettleTimer.scheduleOnce(REPLY_RUN_TERMINAL_SETTLE_TIMEOUT_MS);
  };

  const complete = (
    barrier?: PromiseLike<unknown>,
    timeoutMs?: number | ReplyFollowupAdmissionBarrierTimeoutPolicy,
  ) => {
    producerCompletion.resolve(producerError);
    if (barrier) {
      // Admission may time out to free a slot; the old writer settles only when
      // its actual delivery/persistence barriers finish, including repeated complete().
      const completed = Promise.resolve(barrier).then(
        () => {},
        () => {},
      );
      ownerCompletionBarrier = ownerCompletionBarrier
        ? Promise.all([ownerCompletionBarrier, completed]).then(() => {})
        : completed;
    }
    if (!result) {
      setResult({ kind: "completed" });
    }
    clearState(barrier, timeoutMs);
    // Stale expiry can clear the slot before the old owner's durable work settles.
    settleOwner();
  };

  const abortOperation = (reason: ReplyBackendCancelReason, abortReason: unknown) => {
    const phaseBeforeAbort = phase;
    if (!result) {
      setResult({ kind: "aborted", code: REPLY_OPERATION_ABORT_CODES[reason] });
      detachUpstreamAbort();
    }
    phase = "aborted";
    controller.abort(abortReason);
    // Cancellation may throw, but lifecycle cleanup still must run. Pre-backend
    // non-retained owners release now; retained/running owners await terminal settle.
    try {
      getAttachedBackend(operation)?.cancel(reason);
    } finally {
      if (
        isReplyOperationPreBackendPhase(phaseBeforeAbort) &&
        !retainStateUntilCompleteOperations.has(operation)
      ) {
        operation.complete();
      } else {
        scheduleTerminalSettle();
      }
    }
  };

  const abortIfAllowed = (reason: "user_abort" | "restart") => {
    if (!isReplyOperationAbortable(operation)) {
      return false;
    }
    abortOperation(
      reason,
      reason === "restart" ? createAgentRunRestartAbortError() : createAgentRunDirectAbortError(),
    );
    return true;
  };

  const operation: ReplyOperation = {
    get key() {
      return currentSessionKey;
    },
    get sessionId() {
      return currentSessionId;
    },
    get agentId() {
      return currentAgentId;
    },
    turnKind: params.turnKind ?? "visible",
    lifecycleGeneration,
    get routeThreadId() {
      return params.routeThreadId;
    },
    get originatingLeafEntryId() {
      return params.originatingLeafEntryId;
    },
    abortSignal: controller.signal,
    get resetTriggered() {
      return params.resetTriggered;
    },
    get terminalRecovery() {
      return terminalRecovery;
    },
    get sourceReplyDelivered() {
      return sourceReplyDelivered;
    },
    get acceptedSteeredInboundAudio() {
      return acceptedSteeredInboundAudio;
    },
    get toolAuthorityFingerprint() {
      return toolAuthority.toolAuthorityFingerprint;
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
      return phase;
    },
    get result() {
      return result;
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
    captureOwnedSessionIds() {
      return new Set(ownedSessionIds);
    },
    recordActivity() {
      finalizationLease.recordActivity();
    },
    setPhase(next) {
      if (result) {
        return;
      }
      recordActivity();
      phase = next;
      notifyBackendReady();
      notifyGatewayWorkMetricsChanged();
    },
    markWaitingForDeferredMaintenance() {
      if (result || phase !== "queued") {
        return;
      }
      phase = "waiting_for_deferred_maintenance";
      notifyGatewayWorkMetricsChanged();
      markProgress("deferred_maintenance:waiting");
    },
    markDeferredMaintenanceWaitEnded() {
      if (result || phase !== "waiting_for_deferred_maintenance") {
        return;
      }
      phase = "queued";
      notifyGatewayWorkMetricsChanged();
      markProgress("deferred_maintenance:wait_ended");
    },
    markWaitingForGlobalLane() {
      if (result || (phase !== "queued" && phase !== "running")) {
        return;
      }
      // Queued-on-lane is healthy waiting, not a wedged run. Removing this phase
      // lets stale recovery silently drop replies while global capacity is busy.
      phaseBeforeGlobalLaneWait = phase;
      phase = "waiting_for_global_lane";
      notifyGatewayWorkMetricsChanged();
      markProgress("global_lane:waiting");
    },
    markGlobalLaneWaitEnded() {
      if (result || phase !== "waiting_for_global_lane") {
        return;
      }
      phase = phaseBeforeGlobalLaneWait ?? "queued";
      phaseBeforeGlobalLaneWait = undefined;
      notifyBackendReady();
      notifyGatewayWorkMetricsChanged();
      markProgress("global_lane:wait_ended");
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
    bindToolAuthorityRoute: toolAuthority.bindToolAuthorityRoute,
    bindToolAuthorityRouteAsync: toolAuthority.bindToolAuthorityRouteAsync,
    updateSessionId(nextSessionId) {
      if (result) {
        return;
      }
      const normalizedNextSessionId = normalizeOptionalString(nextSessionId);
      if (!normalizedNextSessionId || normalizedNextSessionId === currentSessionId) {
        return;
      }
      recordActivity();
      if (
        replyRunState.activeKeysBySessionId.has(normalizedNextSessionId) &&
        replyRunState.activeKeysBySessionId.get(normalizedNextSessionId) !== currentSessionKey
      ) {
        throw new Error(
          `Cannot rebind reply operation ${currentSessionKey} to active session ${normalizedNextSessionId}`,
        );
      }
      replyRunState.activeKeysBySessionId.delete(currentSessionId);
      replyRunState.waitKeysBySessionId.set(currentSessionId, currentSessionKey);
      currentSessionId = normalizedNextSessionId;
      ownedSessionIds.add(currentSessionId);
      updateFollowupAdmissionSessionId(operation);
      updateSuccessorAdmissionSessionId(operation, currentSessionId);
      replyRunState.activeKeysBySessionId.set(currentSessionId, currentSessionKey);
      replyRunState.waitKeysBySessionId.set(currentSessionId, currentSessionKey);
      notifyGatewayWorkMetricsChanged();
      markProgress("reply_operation:session_updated");
    },
    updateSessionKey(nextSessionKey, agentId) {
      const update = prepareReplyRunKeyUpdate(operation, nextSessionKey, agentId, stateCleared);
      if (!update) {
        return;
      }
      recordActivity();
      currentAgentId = update.agentId;
      if (update.sessionKey === currentSessionKey) {
        notifyGatewayWorkMetricsChanged();
        return;
      }
      const previousKey = currentSessionKey;
      replyRunState.activeRunsByKey.delete(previousKey);
      currentSessionKey = update.sessionKey;
      backendReady.resolve();
      backendReady = createDeferredCore();
      backendReadyByOperation.set(operation, backendReady.promise);
      replyRunState.activeRunsByKey.set(currentSessionKey, operation);
      replyRunState.activeKeysBySessionId.set(currentSessionId, currentSessionKey);
      // Wait/abort lookups resolve keys via owned session IDs; move them so
      // waitForReplyRunEndBySessionId keeps finding this operation.
      for (const ownedSessionId of ownedSessionIds) {
        if (replyRunState.waitKeysBySessionId.get(ownedSessionId) === previousKey) {
          replyRunState.waitKeysBySessionId.set(ownedSessionId, currentSessionKey);
        }
      }
      notifyGatewayWorkMetricsChanged();
      // The previous key's slot is idle now; wake turns waiting on it.
      notifyReplyRunEnded(previousKey);
      markProgress("reply_operation:session_key_adopted");
    },
    attachBackend(handle) {
      if (result) {
        handle.cancel(
          result.kind === "aborted"
            ? result.code === "aborted_for_restart"
              ? "restart"
              : result.code === "aborted_for_supersession"
                ? "superseded"
                : "user_abort"
            : "superseded",
        );
        return;
      }
      recordActivity();
      toolAuthority.bindBackendFingerprint(handle.toolAuthorityFingerprint);
      attachedBackendByOperation.set(operation, handle);
      notifyBackendReady();
      if (controller.signal.aborted) {
        handle.cancel("superseded");
      }
    },
    detachBackend(handle) {
      if (getAttachedBackend(operation) === handle) {
        attachedBackendByOperation.delete(operation);
      }
    },
    freezeAbort() {
      abortFrozenOperations.add(operation);
      detachUpstreamAbort();
      finalizationLease.begin();
    },
    retainFailureUntilComplete() {
      retainFailureUntilComplete = true;
    },
    ownerSettlement: ownerSettlement.promise,
    complete() {
      complete();
    },
    completeWithAfterClearBarrier: complete,
    fail(code, cause) {
      // Cancellation can win the outcome before the producer rejects its buffered output.
      producerError ??= cause;
      abortFrozenOperations.add(operation);
      detachUpstreamAbort();
      finalizationLease.clear();
      if (!result) {
        setResult({ kind: "failed", code, cause });
      }
      if (!retainFailureUntilComplete && !retainStateUntilCompleteOperations.has(operation)) {
        clearState();
      } else {
        scheduleTerminalSettle();
      }
    },
    abortByUser: () => abortIfAllowed("user_abort"),
    abortForRestart: () => abortIfAllowed("restart"),
    supersede(beforeSupersede) {
      const abortFrozen = abortFrozenOperations.has(operation);
      if (result || stateCleared || (!abortFrozen && !isReplyOperationAbortable(operation))) {
        return false;
      }
      beforeSupersede?.();
      if (abortFrozen) {
        setResult({ kind: "aborted", code: "aborted_for_supersession" });
        scheduleTerminalSettle();
        return true;
      }
      abortOperation("superseded", createSupersededError());
      return true;
    },
  };

  clearReplyOperationByOperation.set(operation, clearState);
  producerCompletionByOperation.set(operation, producerCompletion.promise);
  backendReadyByOperation.set(operation, backendReady.promise);
  expireReplyOperationByOperation.set(operation, (reason, options) => {
    if (
      replyRunState.activeRunsByKey.get(currentSessionKey) !== operation ||
      (reason !== "finalization_stalled" && hasCommittedReplyOperationOutcome(operation))
    ) {
      return false;
    }
    // Set the terminal result BEFORE cancelling the backend: cancel can
    // synchronously re-enter abortByUser() from the run loop's abort handler,
    // which would stamp aborted_by_user and misattribute a watchdog expiry.
    if (!result) {
      abortFrozenOperations.add(operation);
      detachUpstreamAbort();
      // The reason distinguishes pre-run drops (user got nothing; feedback owed)
      // from post-output stalls (finalization/terminal cleanup; feedback is noise).
      staleExpiryReason = reason;
      setResult({ kind: "failed", code: "run_stalled" });
    }
    if (options?.afterClearBarrier) {
      // Prepare the recovery fence before cancellation, but retain exact lane
      // ownership until cancel returns or the backend re-enters completion.
      pendingClearBarrier = registerFollowupAdmissionBarrier(
        operation,
        options.afterClearBarrier,
        options.followupAdmissionBarrierTimeout,
      );
    }
    const backend = getAttachedBackend(operation);
    let cancelFailed = false;
    try {
      backend?.cancel("superseded");
    } catch (error) {
      cancelFailed = true;
      diag.warn(
        `reply run stale takeover cancel failed: sessionKey=${currentSessionKey} reason=${reason} owner=${stateCleared ? "completed" : "retained"} error=${String(error)}`,
      );
    }
    controller.abort(createAbortError("Reply operation expired as stale"));
    if (stateCleared) {
      warnForcedRelease("stale takeover", reason);
      return true;
    }
    // cancel() only requests shutdown. A missing backend can also be a live
    // pre-attachment owner, so only complete() may release the exact lane token.
    if (!cancelFailed) {
      diag.warn(
        `reply run stale takeover retained: sessionKey=${currentSessionKey} reason=${reason} owner=awaiting_terminal_completion backend=${backend ? "attached" : "pending"}`,
      );
    }
    scheduleTerminalSettle();
    return false;
  });
  const finalizationLease = replyRunSettle.createReplyRunFinalizationLease({
    owner: operation,
    canExpire: () =>
      !stateCleared &&
      !result &&
      replyRunState.activeRunsByKey.get(currentSessionKey) === operation,
    onActivity: recordActivity,
    onFinalizationProgress: () => markProgress("reply_operation:finalizing_progress"),
    onExpire: () => {
      warnForcedRelease("finalization settle");
      const expired = expireReplyOperationByOperation.get(operation)?.("finalization_stalled");
      if (expired === false && replyRunState.activeRunsByKey.get(currentSessionKey) === operation) {
        // This lease is the finalization owner's bounded shutdown deadline.
        // Do not grant a second terminal-settle lifetime after it expires.
        forceClearReplyOperation(operation);
      }
    },
  });
  const terminalSettleTimer = replyRunSettle.createReplyRunSettleTimer({
    canExpire: () => replyRunState.activeRunsByKey.get(currentSessionKey) === operation,
    onExpire: () => {
      // Retained terminal results get one delivery grace window, not a second lifetime.
      warnForcedRelease("terminal settle");
      clearState();
    },
  });

  evictReplyOperationByOperation.set(operation, () => {
    if (stateCleared) {
      return;
    }
    if (!result) {
      setResult({ kind: "aborted", code: "aborted_for_restart" });
    }
    controller.abort(createAgentRunRestartAbortError());
    try {
      getAttachedBackend(operation)?.cancel("restart");
    } catch (error) {
      diag.warn(
        `reply run lifecycle eviction cancel failed: sessionKey=${currentSessionKey} error=${String(error)}`,
      );
      throw error;
    } finally {
      clearState();
    }
  });

  replyRunState.activeRunsByKey.set(sessionKey, operation);
  replyRunState.activeKeysBySessionId.set(currentSessionId, sessionKey);
  replyRunState.waitKeysBySessionId.set(currentSessionId, sessionKey);
  notifyGatewayWorkMetricsChanged();
  markProgress("reply_operation:queued");
  if (upstreamAbortSignal) {
    operationsByUpstreamAbortSignal.set(upstreamAbortSignal, operation);
    const abortFromUpstream = () => {
      if (result) {
        return;
      }
      const restart = isAgentRunRestartAbortReason(upstreamAbortSignal.reason);
      const superseded = isAgentRunSupersededAbortReason(upstreamAbortSignal.reason);
      abortOperation(
        restart ? "restart" : superseded ? "superseded" : "user_abort",
        upstreamAbortSignal.reason,
      );
    };
    if (upstreamAbortSignal.aborted) {
      abortFromUpstream();
    } else {
      upstreamAbortHandler = abortFromUpstream;
      upstreamAbortSignal.addEventListener("abort", upstreamAbortHandler, { once: true });
    }
  }

  return operation;
}
