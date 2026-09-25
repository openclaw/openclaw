import { randomUUID } from "node:crypto";
import { isFutureDateTimestampMs } from "@openclaw/normalization-core/number-coercion";
import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import {
  createAgentRunRestartAbortError,
  isAgentRunDirectAbortReason,
} from "../../agents/run-termination.js";
import {
  interruptReplyRunTarget,
  isReplyRunAbortableForSignal,
  REPLY_RUN_IDLE_SETTLE_TIMEOUT_MS,
  replyRunRegistry,
  type ReplyMessageInjectionTarget,
  type ReplyOperation,
} from "../../auto-reply/reply/reply-run-registry.js";
import { resolveActiveReplyRunOwnerForSignal } from "../../auto-reply/reply/reply-run-registry.state.js";
import { resolveSessionWorkStartError } from "../../config/sessions.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { claimAgentRunContext, clearAgentRunContext } from "../../infra/agent-run-registry.js";
import { retainGatewayRootWorkAdmissionContinuation } from "../../process/gateway-work-admission.js";
import {
  isProgressCardRefreshInputProvenance,
  progressCardRefreshRunProjection,
} from "../../sessions/input-provenance.js";
import {
  beginSessionWorkAdmission,
  interruptSessionWorkAdmissions,
  isCompetingSessionWorkAdmissionActive,
} from "../../sessions/session-lifecycle-admission.js";
import { captureAgentJobSession, setGatewayDedupeEntry } from "../agent-turn/agent-job.js";
import { registerChatAbortController, resolveChatRunExpiresAtMs } from "../chat-abort.js";
import { ExpectedProfileMismatchError } from "../expected-profile.js";
import { retainGatewayOperatorRun } from "../operator-run-cancellation.js";
import { PENDING_CHAT_SEND_DEDUPE_PREFIX, type DedupeEntry } from "../server-shared.js";
import {
  buildAbortedChatSendPayload,
  readPreRegisteredRun,
  writePreRegisteredChatAbort,
} from "./chat-abort-authorization.js";
import { resolveChatSendOriginatingRoute } from "./chat-origin-routing.js";
import {
  hasRestartRecoveryTerminalRun,
  isRetryableUnadoptedChatClaim,
  resolveRestartSafeChatAdmission,
} from "./chat-restart-recovery.js";
import { assertExpectedLeafActive } from "./chat-send-active-leaf.js";
import {
  inspectGoalChatSendRetry,
  readChatSendDedupeResponse,
  resolveChatSendRequestConflict,
  respondChatSendAdmissionError,
  respondChatSendRetry,
  respondChatSessionRoutingChanged,
  type ChatSendPreAdmissionParams,
} from "./chat-send-pre-admission.js";
import { bindChatSendPreparedSession } from "./chat-send-session-binding.js";
import { captureAdmittedChatSendSessionSettings } from "./chat-send-session-settings.js";
import {
  loadCurrentChatSendSession,
  prepareChatSendSessionEntry,
  type PreparedChatSendSession,
} from "./chat-send-session.js";
import {
  assertChatSendExclusiveAdmission,
  createChatSendWorkAdmission,
  releaseChatSendCallerAuthority,
} from "./chat-send-work-admission.js";
import { normalizeOptionalChatText, normalizeUnknownChatText } from "./chat-text-normalization.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

/** Reserve the session lifecycle and register the abortable run before attachment work. */
export async function admitChatSend(
  params: ChatSendPreAdmissionParams & {
    session: PreparedChatSendSession;
    hasCurrentClientAuthority?: GatewayRequestHandlerOptions["hasCurrentClientAuthority"];
    onAdmissionOwned?: () => Promise<boolean>;
  },
) {
  params.assertCurrent?.();
  const { request, session, respond, context, client } = params;
  const { p, explicitOrigin, normalizedAttachments, turnKind } = request;
  const progressRefresh = isProgressCardRefreshInputProvenance(request.systemInputProvenance);
  const {
    rawSessionKey,
    clientRunId,
    pendingChatSendKey,
    cfg,
    storePath,
    entry,
    sessionKey,
    selectedAgent,
    requestedSessionId,
    backingSessionId,
    agentId,
    resolvedSessionModel,
    resolvedSessionAuthProvider,
    activeRunScopeKey,
    timeoutMs,
    now,
    restartSafeRequest,
    expectedLeafEntryId,
  } = session;
  const assertSessionTargetCurrent = session.assertSessionTargetCurrent;
  const chatSendTraceAttributes = {
    runId: clientRunId,
    sessionKey,
    agentId: selectedAgent.agentId ?? agentId,
    provider: resolvedSessionModel.provider,
    model: resolvedSessionModel.model,
    hasAttachments: normalizedAttachments.length > 0,
    hasExplicitOrigin: explicitOrigin !== undefined,
    hasConnectedClient: client?.connect !== undefined,
  };
  const originatingRoute = resolveChatSendOriginatingRoute({
    client: request.clientInfo,
    deliver: p.deliver,
    entry,
    explicitOrigin,
    hasConnectedClient: client?.connect !== undefined,
    mainKey: cfg.session?.mainKey,
    sessionKey,
  });
  const lifecycleGeneration = getAgentEventLifecycleGeneration();
  const pendingAttemptId = randomUUID();
  const readPendingReservation = () =>
    readPreRegisteredRun({
      key: pendingChatSendKey,
      entry: context.dedupe.get(pendingChatSendKey),
      keyPrefix: PENDING_CHAT_SEND_DEDUPE_PREFIX,
    });
  const goalRetry = inspectGoalChatSendRetry(params);
  if (goalRetry.kind !== "new") {
    if (goalRetry.kind === "replay") {
      respond(true, { ...goalRetry.receipt, replayed: true }, undefined, {
        cached: true,
        runId: clientRunId,
      });
    }
    return { ok: false as const };
  }
  // A plain chat retry must not replace a Goal reservation after yielding in recovery.
  if (readPendingReservation()?.payload.goalFingerprint) {
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, "Run ID is reserved by a Goal request; use a new ID."),
    );
    return { ok: false as const };
  }
  if (!request.goalOperation && respondChatSendRetry(params)) {
    return { ok: false as const };
  }
  // Keep the run abortable while lifecycle mutation owns the session. Admission
  // must reject an expired/missing reservation instead of reviving evicted work.
  params.assertCurrent?.();
  context.dedupe.set(pendingChatSendKey, {
    ts: now,
    ok: true,
    requestIdentity: request.requestIdentity,
    payload: {
      runId: clientRunId,
      attemptId: pendingAttemptId,
      status: "accepted" as const,
      sessionKey,
      ...(backingSessionId ? { sessionId: backingSessionId } : {}),
      ...(rawSessionKey === sessionKey ? {} : { sessionKeyAliases: [rawSessionKey] }),
      ...(selectedAgent.agentId ? { agentId: selectedAgent.agentId } : {}),
      ownerConnId: normalizeOptionalChatText(client?.connId),
      ownerDeviceId: normalizeOptionalChatText(client?.connect?.device?.id),
      expiresAtMs: resolveChatRunExpiresAtMs({ now, timeoutMs }),
      turnKind,
      ...(request.goalOperation
        ? { goalFingerprint: request.goalOperation.requestFingerprint }
        : {}),
    },
  });
  const clearPendingChatSendReservation = () => {
    const pending = readPendingReservation();
    if (
      pending?.runId === clientRunId &&
      normalizeUnknownChatText(pending.payload.attemptId) === pendingAttemptId
    ) {
      context.dedupe.delete(pendingChatSendKey);
    }
  };
  let admittedSessionId = backingSessionId ?? clientRunId;
  let expectedActiveReplyOperation: ReplyOperation | undefined;
  let gatewayWorkAdmission: Awaited<ReturnType<typeof beginSessionWorkAdmission>> | undefined;
  let admittedRunAbort: ReturnType<typeof registerChatAbortController> | undefined;
  let restartSafeAdmission: ReturnType<typeof resolveRestartSafeChatAdmission>;
  let initialSessionEntry: SessionEntry | undefined;
  let admittedSessionSettings: ReturnType<typeof captureAdmittedChatSendSessionSettings>;
  let assertInitialSkillSelection: (() => void) | undefined;
  let messageInjectionTarget: ReplyMessageInjectionTarget | undefined;
  let runInterruptTarget: ReturnType<typeof replyRunRegistry.resolveCurrentInterruptTarget>;
  let reservationSuperseded = false;
  let supersedingResult: DedupeEntry | undefined;
  const assertChatWorkAdmissionAllowed = (commitOutcome: boolean) => {
    params.assertCurrent?.();
    const retainedRequestConflict = resolveChatSendRequestConflict(params);
    if (retainedRequestConflict) {
      throw new Error(retainedRequestConflict.message);
    }
    if (context.chatRunState.hasAbortMarker(clientRunId)) {
      return;
    }
    const pendingReservation = readPendingReservation();
    if (
      pendingReservation &&
      normalizeUnknownChatText(pendingReservation.payload.attemptId) !== pendingAttemptId
    ) {
      if (commitOutcome) {
        reservationSuperseded = true;
      }
      return;
    }
    if (!pendingReservation) {
      const terminalResult = readChatSendDedupeResponse(context.dedupe, clientRunId);
      if (terminalResult || context.chatAbortControllers.has(clientRunId)) {
        if (commitOutcome) {
          reservationSuperseded = true;
          supersedingResult = terminalResult;
        }
        return;
      }
    }
    if (lifecycleGeneration !== getAgentEventLifecycleGeneration()) {
      if (commitOutcome) {
        writePreRegisteredChatAbort({
          context,
          runId: clientRunId,
          stopReason: "restart",
          attemptId: pendingAttemptId,
        });
      }
      return;
    }
    if (
      !pendingReservation ||
      !isFutureDateTimestampMs(pendingReservation.payload.expiresAtMs, { nowMs: Date.now() })
    ) {
      if (commitOutcome) {
        writePreRegisteredChatAbort({
          context,
          runId: clientRunId,
          stopReason: "timeout",
          attemptId: pendingAttemptId,
        });
      }
      return;
    }
    const latestSession = loadCurrentChatSendSession(session);
    const latestEntry = latestSession.entry;
    const requestConflict = resolveChatSendRequestConflict({
      ...params,
      session: { ...session, entry: latestEntry },
    });
    if (requestConflict) {
      throw new Error(requestConflict.message);
    }
    // Freeze the writer-barrier snapshot; later preparation must retain this authority.
    admittedSessionSettings = captureAdmittedChatSendSessionSettings({
      commit: commitOutcome,
      entry: latestEntry,
      expectedPermissionMode: p.expectedPermissionMode,
      expectedToolOverrides: p.expectedToolOverrides,
    });
    assertChatSendExclusiveAdmission(request, session);
    if (entry && !latestEntry) {
      throw new Error(`Session "${sessionKey}" was deleted while starting work. Retry.`);
    }
    // Capture the exact direct owner under the writer barrier. If it clears
    // later, the opaque target rejects instead of resolving a successor.
    const resolvedInjectionTarget =
      p.queueMode === "steer"
        ? replyRunRegistry.resolveCurrentMessageInjectionTarget(activeRunScopeKey)
        : undefined;
    if (commitOutcome && resolvedInjectionTarget) {
      messageInjectionTarget = resolvedInjectionTarget;
    }
    const resolvedInterruptTarget =
      p.queueMode === "interrupt"
        ? replyRunRegistry.resolveCurrentInterruptTarget(activeRunScopeKey)
        : undefined;
    if (commitOutcome && resolvedInterruptTarget) {
      runInterruptTarget = resolvedInterruptTarget;
    }
    if (commitOutcome && p.queueMode !== "steer" && expectedLeafEntryId !== undefined) {
      assertExpectedLeafActive(latestSession, agentId, expectedLeafEntryId, requestedSessionId);
    }
    // Admission can queue behind reset. Never route a request captured
    // against the old session into the replacement transcript. Expected-leaf sends
    // defer this check to locked revalidation so branch rotation returns its typed error.
    if (
      backingSessionId &&
      latestEntry?.sessionId &&
      latestEntry.sessionId !== backingSessionId &&
      (expectedLeafEntryId === undefined || commitOutcome)
    ) {
      throw new Error(`Session "${sessionKey}" changed while starting work. Retry.`);
    }
    const retryableClaim = isRetryableUnadoptedChatClaim(latestEntry, clientRunId);
    if (
      (latestEntry?.restartRecoveryDeliveryRunId &&
        latestEntry.restartRecoveryDeliverySourceRunId === clientRunId &&
        !retryableClaim) ||
      hasRestartRecoveryTerminalRun(latestEntry, clientRunId)
    ) {
      // Recovery can settle while this retry waits on lifecycle admission.
      // Revalidate under that admission so a stale pre-lock snapshot cannot dispatch twice.
      if (commitOutcome) {
        reservationSuperseded = true;
        supersedingResult = {
          ts: Date.now(),
          ok: true,
          payload: { runId: clientRunId, status: "ok" as const },
        };
      }
      return;
    }
    const archivedError = resolveSessionWorkStartError(sessionKey, latestEntry, {
      allowPendingWorkspace: true,
      providerReviewAcknowledgment: request.providerReviewAcknowledgment,
      runId: clientRunId,
    });
    if (archivedError) {
      throw new Error(archivedError);
    }
    if (!commitOutcome) {
      return;
    }
    admittedSessionId = latestEntry?.sessionId ?? backingSessionId ?? clientRunId;
    // Retain compaction lineage before attachment/context preparation can outlive this owner.
    expectedActiveReplyOperation = replyRunRegistry.get(activeRunScopeKey);
    if (request.goalOperation?.action === "start" && !latestEntry && !requestedSessionId) {
      const prepared = prepareChatSendSessionEntry({
        cfg: latestSession.cfg,
        client,
        agentId,
        getRuntimeConfig: context.getRuntimeConfig,
      });
      initialSessionEntry = prepared.entry;
      assertInitialSkillSelection = prepared.assertSkillSelection;
      admittedSessionId = initialSessionEntry.sessionId;
    }
    restartSafeAdmission = resolveRestartSafeChatAdmission({
      activeRunScopeKey,
      agentId,
      cfg: latestSession.cfg,
      clientRunId,
      context,
      entry: latestEntry,
      initialSessionEntry,
      now: Date.now(),
      request: restartSafeRequest,
      requestedSessionId,
      sessionId: admittedSessionId,
      sessionKey: latestSession.canonicalKey,
      storePath: latestSession.storePath,
    });
    if (request.goalOperation && !restartSafeAdmission) {
      throw new Error(
        "Goal start or resume requires the built-in OpenClaw runtime and an idle local session with recoverable history. This action is unavailable for native Codex and other external runtimes.",
      );
    }
    if (retryableClaim && !restartSafeAdmission) {
      throw new Error("chat retry does not match its durable admission");
    }
    // A terminal Control UI claim can survive a crash after status commit.
    // The transcript transaction merges its source with fresh tombstones.
    admittedRunAbort = registerChatAbortController({
      chatAbortControllers: context.chatAbortControllers,
      runId: clientRunId,
      sessionId: admittedSessionId,
      sessionKey,
      agentId: selectedAgent.agentId,
      timeoutMs,
      now,
      ownerConnId: normalizeOptionalChatText(client?.connId),
      ownerDeviceId: normalizeOptionalChatText(client?.connect?.device?.id),
      providerId: resolvedSessionModel.provider,
      authProviderId: resolvedSessionAuthProvider,
      isAbortable: (active) => isReplyRunAbortableForSignal(active.controller.signal),
      resolveTerminalProducer: (active) =>
        resolveActiveReplyRunOwnerForSignal(active.controller.signal),
      kind: "chat-send",
      turnKind,
      ...(progressRefresh ? { controlUiVisible: false, projectSessionActive: false } : {}),
      lifecycleGeneration,
    });
  };

  try {
    gatewayWorkAdmission = await beginSessionWorkAdmission({
      scope: storePath,
      identities: [sessionKey, backingSessionId],
      assertAllowed: () => assertChatWorkAdmissionAllowed(false),
      revalidateAllowed: () => assertChatWorkAdmissionAllowed(true),
      onInterrupt: (reason) => {
        const stopReason = isAgentRunDirectAbortReason(reason) ? "rpc" : "restart";
        if (!admittedRunAbort) {
          if (!context.chatRunState.hasAbortMarker(clientRunId)) {
            writePreRegisteredChatAbort({
              context,
              runId: clientRunId,
              stopReason,
              attemptId: pendingAttemptId,
            });
          }
        } else if (!admittedRunAbort.controller.signal.aborted) {
          // A later lifecycle drain must not overwrite the first abort reason.
          if (admittedRunAbort.entry) {
            admittedRunAbort.entry.abortStopReason = stopReason;
          }
          admittedRunAbort.controller.abort(
            stopReason === "rpc" ? reason : createAgentRunRestartAbortError(),
          );
        }
      },
    });
    params.assertCurrent?.();
  } catch (err) {
    clearPendingChatSendReservation();
    admittedRunAbort?.cleanup();
    gatewayWorkAdmission?.release();
    if (err instanceof ExpectedProfileMismatchError) {
      throw err;
    }
    const requestConflict = resolveChatSendRequestConflict(params);
    if (requestConflict) {
      respond(false, undefined, requestConflict);
      return { ok: false as const };
    }
    const aborted =
      context.chatRunState.hasAbortMarker(clientRunId) &&
      readChatSendDedupeResponse(context.dedupe, clientRunId);
    if (aborted) {
      respond(aborted.ok, aborted.payload, aborted.error, { cached: true, runId: clientRunId });
      return { ok: false as const };
    }
    respondChatSendAdmissionError(err, respond);
    return { ok: false as const };
  }
  const retainedRequestConflict = resolveChatSendRequestConflict(params);
  if (retainedRequestConflict) {
    clearPendingChatSendReservation();
    admittedRunAbort?.cleanup();
    gatewayWorkAdmission.release();
    respond(false, undefined, retainedRequestConflict);
    return { ok: false as const };
  }
  if (
    !request.goalOperation &&
    admittedRunAbort?.registered &&
    !reservationSuperseded &&
    !readChatSendDedupeResponse(context.dedupe, clientRunId)
  ) {
    // Transfer immutable input identity before retiring the pending reservation.
    // It survives transient pre-ACK failures without inventing a successful response.
    context.dedupe.set(`chat:${clientRunId}`, {
      ts: Date.now(),
      ok: true,
      requestIdentity: request.requestIdentity,
    });
  }
  clearPendingChatSendReservation();
  const activeRunAbort = admittedRunAbort;
  if (reservationSuperseded) {
    gatewayWorkAdmission.release();
    const supersedingCached =
      supersedingResult ?? readChatSendDedupeResponse(context.dedupe, clientRunId);
    if (supersedingCached) {
      respond(supersedingCached.ok, supersedingCached.payload, supersedingCached.error, {
        cached: true,
        runId: clientRunId,
      });
      return { ok: false as const };
    }
    respond(true, { runId: clientRunId, status: "in_flight" as const }, undefined, {
      cached: true,
      runId: clientRunId,
    });
    return { ok: false as const };
  }
  if (lifecycleGeneration !== getAgentEventLifecycleGeneration()) {
    if (activeRunAbort) {
      if (activeRunAbort.entry) {
        activeRunAbort.entry.abortStopReason = "restart";
      }
      activeRunAbort.controller.abort();
      activeRunAbort.cleanup();
    }
    gatewayWorkAdmission.release();
    if (!readChatSendDedupeResponse(context.dedupe, clientRunId)) {
      writePreRegisteredChatAbort({
        context,
        runId: clientRunId,
        stopReason: activeRunAbort?.entry?.abortStopReason ?? "restart",
        attemptId: pendingAttemptId,
      });
    }
    const aborted = readChatSendDedupeResponse(context.dedupe, clientRunId);
    respond(aborted?.ok ?? true, aborted?.payload, aborted?.error, {
      cached: true,
      runId: clientRunId,
    });
    return { ok: false as const };
  }
  if (!activeRunAbort) {
    gatewayWorkAdmission.release();
    const aborted = readChatSendDedupeResponse(context.dedupe, clientRunId);
    if (aborted) {
      respond(aborted.ok, aborted.payload, aborted.error, {
        cached: true,
        runId: clientRunId,
      });
      return { ok: false as const };
    }
    respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, "chat run admission failed"));
    return { ok: false as const };
  }
  if (!activeRunAbort.registered) {
    gatewayWorkAdmission.release();
    respond(true, { runId: clientRunId, status: "in_flight" as const }, undefined, {
      cached: true,
      runId: clientRunId,
    });
    return { ok: false as const };
  }
  let releaseGatewayRootContinuation = () => {};
  let releaseCallerAuthority: (() => void) | undefined;
  let capturedOperator: Awaited<ReturnType<typeof retainGatewayOperatorRun>>;
  // Until dispatch takes custody, interruption and callback failures release every admission hold.
  const cleanupPreDispatchAdmission = () => {
    try {
      activeRunAbort.cleanup();
      gatewayWorkAdmission.release();
      releaseGatewayRootContinuation();
    } finally {
      releaseCallerAuthority?.();
      releaseCallerAuthority = undefined;
    }
  };
  let interruptedActiveRun = false;
  try {
    capturedOperator = await retainGatewayOperatorRun({
      ...params,
      runId: clientRunId,
      entry: activeRunAbort.entry,
    });
    releaseCallerAuthority = () =>
      releaseChatSendCallerAuthority({ operator: capturedOperator, request, session });
    params.assertCurrent?.();
    activeRunAbort.controller.signal.throwIfAborted();
    capturedOperator.authority?.assertCurrent();
    try {
      assertSessionTargetCurrent();
    } catch (error) {
      cleanupPreDispatchAdmission();
      respondChatSendAdmissionError(error, respond);
      return { ok: false as const };
    }
    let interruptionSettled = true;
    if (runInterruptTarget) {
      interruptedActiveRun = true;
      interruptionSettled = (
        await interruptReplyRunTarget(runInterruptTarget, REPLY_RUN_IDLE_SETTLE_TIMEOUT_MS)
      ).settled;
    } else if (p.queueMode === "interrupt") {
      const identities = [sessionKey, backingSessionId, admittedSessionId];
      // The fallback runs inside the new admission so the lifecycle owner excludes itself.
      // A captured reply operation never falls through to this identity-scoped path.
      const fallback = await gatewayWorkAdmission.run(async () => {
        params.assertCurrent?.();
        if (!isCompetingSessionWorkAdmissionActive(storePath, identities)) {
          return { interrupted: false, settled: true };
        }
        return {
          interrupted: true,
          settled: await interruptSessionWorkAdmissions({
            scope: storePath,
            identities,
            timeoutMs: REPLY_RUN_IDLE_SETTLE_TIMEOUT_MS,
          }),
        };
      });
      interruptedActiveRun = fallback.interrupted;
      interruptionSettled = fallback.settled;
    }
    params.assertCurrent?.();
    if (!interruptionSettled) {
      cleanupPreDispatchAdmission();
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.UNAVAILABLE,
          "Previous run is still shutting down. Please try again in a moment.",
          { retryable: true, retryAfterMs: 250 },
        ),
      );
      return { ok: false as const };
    }
    // Reserve while the request root is live: detached dispatch retains it until terminal persistence.
    releaseGatewayRootContinuation = retainGatewayRootWorkAdmissionContinuation() ?? (() => {});
    if (params.onAdmissionOwned && !(await gatewayWorkAdmission.run(params.onAdmissionOwned))) {
      cleanupPreDispatchAdmission();
      return { ok: false as const };
    }
    params.assertCurrent?.();
    try {
      assertSessionTargetCurrent();
    } catch (error) {
      cleanupPreDispatchAdmission();
      respondChatSendAdmissionError(error, respond);
      return { ok: false as const };
    }
  } catch (error) {
    cleanupPreDispatchAdmission();
    throw error;
  }

  const acquiredGatewayWorkAdmission = gatewayWorkAdmission;
  const sessionBinding = activeRunAbort.entry;
  const onSessionPrepared = bindChatSendPreparedSession({
    chatAbortControllers: context.chatAbortControllers,
    clientRunId,
    sessionKey,
    sessionBinding,
    lifecycleGeneration,
    admission: acquiredGatewayWorkAdmission,
    progressRefresh,
  });
  const retainedWork = createChatSendWorkAdmission({
    admission: acquiredGatewayWorkAdmission,
    releaseCallerAuthority,
    logGateway: context.logGateway,
  });
  // Prepared inbound media has no transcript reference until the user turn
  // persists; every abandonment exit funnels through cleanupAdmittedRun, so
  // the armed discard here is the single custody owner for that window. The
  // handler disarms it once the media becomes referenced (durable admission
  // or ACK handing ownership to dispatch, which persists on all paths).
  let discardAbandonedPreparedMedia: (() => void) | undefined;
  const cleanupAdmittedRun: typeof activeRunAbort.cleanup = () => {
    activeRunAbort.cleanup();
    retainedWork.release();
    releaseGatewayRootContinuation();
    discardAbandonedPreparedMedia?.();
    discardAbandonedPreparedMedia = undefined;
  };
  const rejectSessionRoutingChanged = () => {
    cleanupAdmittedRun();
    clearAgentRunContext(clientRunId, lifecycleGeneration);
    respondChatSessionRoutingChanged(respond);
  };
  const finishAbortedChatSend = () => {
    const stopReason = activeRunAbort.entry?.abortStopReason ?? "rpc";
    const endedAt = Date.now();
    const payload = buildAbortedChatSendPayload({ runId: clientRunId, stopReason, endedAt });
    setGatewayDedupeEntry({
      dedupe: context.dedupe,
      key: `chat:${clientRunId}`,
      session: captureAgentJobSession(sessionBinding),
      entry: { ts: endedAt, ok: true, payload },
    });
    cleanupAdmittedRun();
    clearAgentRunContext(clientRunId, lifecycleGeneration);
    respond(true, payload, undefined, { runId: clientRunId });
  };
  claimAgentRunContext(clientRunId, {
    agentId: selectedAgent.agentId ?? agentId,
    sessionKey,
    sessionId: admittedSessionId,
    lifecycleGeneration,
    ...progressCardRefreshRunProjection(request.systemInputProvenance),
  });

  return {
    ok: true as const,
    value: {
      activeRunAbort,
      operatorAuthority: capturedOperator.authority,
      armOperatorRunCancellation: capturedOperator.armCancellation,
      retireOperatorRunCancellation: capturedOperator.retireCancellation,
      admittedSessionSettings,
      admittedSessionId,
      ...(expectedActiveReplyOperation ? { expectedActiveReplyOperation } : {}),
      sessionBinding,
      onSessionPrepared,
      initialSessionEntry,
      chatSendTraceAttributes,
      assertInitialSkillSelection,
      assertSessionTargetCurrent,
      cleanupAdmittedRun,
      finishAbortedChatSend,
      gatewayWorkAdmission,
      lifecycleGeneration,
      interruptedActiveRun,
      messageInjectionTarget,
      originatingRoute,
      rejectSessionRoutingChanged,
      retainGatewayWorkAdmission: retainedWork.retain,
      setPendingInputCleanup: retainedWork.setPendingInputCleanup,
      assertWorkAdmissionCurrent: () => {
        const queued = context.chatQueuedTurns.get(clientRunId);
        // Collect retires source cancellation while retaining the original
        // admission until the aggregate commits or settles.
        if (
          !retainedWork.isActive() ||
          !acquiredGatewayWorkAdmission.isActive() ||
          lifecycleGeneration !== getAgentEventLifecycleGeneration() ||
          (activeRunAbort.controller.signal.aborted &&
            !(queued?.controller === activeRunAbort.controller && queued.abortable === false))
        ) {
          throw new Error("Chat admission ended or was cancelled; submit a new turn.");
        }
      },
      restartSafeAdmission,
      setDiscardAbandonedPreparedMedia: (discard: (() => void) | undefined) => {
        discardAbandonedPreparedMedia = discard;
      },
    },
  };
}

type ChatSendAdmissionResult = Awaited<ReturnType<typeof admitChatSend>>;
export type AdmittedChatSend = Extract<ChatSendAdmissionResult, { ok: true }>["value"];
