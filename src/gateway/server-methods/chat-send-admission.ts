import { randomUUID } from "node:crypto";
import { isFutureDateTimestampMs } from "@openclaw/normalization-core/number-coercion";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { createAgentRunRestartAbortError } from "../../agents/run-termination.js";
import { resolveQueueSettings } from "../../auto-reply/reply/queue/settings-runtime.js";
import { resolveSessionWorkStartError } from "../../config/sessions.js";
import { SESSION_ROUTING_CHANGED_ERROR_REASON } from "../../config/sessions/main-session.js";
import {
  hasRestartRecoveryTerminalRun,
  isRetryableUnadoptedChatClaim,
} from "../../config/sessions/restart-recovery-state.js";
import { isSessionTranscriptProjectionUnavailableError } from "../../config/sessions/session-transcript-projection-error.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { claimAgentRunContext, clearAgentRunContext } from "../../infra/agent-run-registry.js";
import {
  isProgressCardRefreshInputProvenance,
  progressCardRefreshRunProjection,
} from "../../sessions/input-provenance.js";
import { resolveActiveReplyRunOwnerForSignal } from "../../sessions/session-controller.barriers.js";
import type {
  ReplyMessageInjectionTarget,
  ReplyOperation,
} from "../../sessions/session-controller.js";
import {
  beginSessionEffect,
  captureSessionTarget,
} from "../../sessions/session-controller.lifecycle.js";
import { captureCurrentReplyMessageInjectionTarget } from "../../sessions/session-controller.message-injection.js";
import {
  hasRpcSourceForController,
  isRpcSourceRegistered,
} from "../../sessions/session-controller.rpc-sources.js";
import { captureSessionControllerInterruptBefore } from "../../sessions/session-controller.stop-runtime.js";
import { registerChatAbortController } from "../chat-abort.js";
import type { DedupeEntry } from "../server-shared.js";
import {
  resolveRestartSafeChatAdmission,
  withRestartSafeChatPlacement,
  type PreparedRestartSafeChatPlacement,
} from "./chat-restart-recovery.js";
import { assertExpectedLeafActive } from "./chat-send-active-leaf.js";
import {
  createAdmittedChatSendCleanup,
  finishAbortedChatSend as publishAbortedChatSend,
  prepareAdmittedChatSendDispatch,
  releaseChatSendCallerAuthority,
} from "./chat-send-admission-cleanup.js";
import {
  prepareChatSendAdmissionContext,
  prepareChatSendAcpMetadata,
  prepareChatSendAcpRefresh,
} from "./chat-send-admission-context.js";
import { respondChatSessionRoutingChanged } from "./chat-send-admission-errors.js";
import { isWorkerGoalChatAdmission } from "./chat-send-goal-admission.js";
import { prepareGoalChatSendRetry } from "./chat-send-goal-retry.js";
import { prepareChatSendInterruptAdmission } from "./chat-send-interrupt-admission.js";
import {
  consumeChatSendCurrent,
  resolveChatSendRequestConflict,
} from "./chat-send-pre-admission.js";
import type { ChatSendAdmissionParams } from "./chat-send-pre-admission.types.js";
import {
  createPendingChatSendReservationAccess,
  inspectGoalChatSendRetry,
  readChatSendDedupeResponse,
} from "./chat-send-reservation.js";
import { bindChatSendPreparedSession } from "./chat-send-session-binding.js";
import { captureAdmittedChatSendSessionSettings } from "./chat-send-session-settings.js";
import { prepareChatSendSessionEntry } from "./chat-send-session.js";
import {
  admitChatSendUploads,
  assertChatSendExclusiveAdmission,
  assertChatSendWorkAdmissionCurrent,
  createChatSendWorkAdmission,
  consumeChatSendAdmissionRetry,
  observeChatSendWork,
  prepareChatSendAdmissionRetry,
  respondChatSendWorkAdmissionFailure,
  withCurrentChatSendRetry,
} from "./chat-send-work-admission.js";

/** Reserve the session lifecycle and register the abortable run before attachment work. */
export async function admitChatSend(params: ChatSendAdmissionParams) {
  const { request, session, respond, context, client, diagnostics } = params;
  const { p, turnKind } = request;
  const requestIdentity = request.goalOperation?.requestFingerprint ?? request.requestIdentity;
  const progressRefresh = isProgressCardRefreshInputProvenance(request.systemInputProvenance);
  const {
    rawSessionKey,
    clientRunId,
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
    restartSafeRequest,
    expectedLeafEntryId,
  } = session;
  const assertSessionTargetCurrent = () => {
    if (session.sessionRoutingChanged(context.getRuntimeConfig())) {
      throw new Error(SESSION_ROUTING_CHANGED_ERROR_REASON);
    }
  };
  const cachedMeta = { cached: true, runId: clientRunId };
  const { chatSendTraceAttributes, originatingRoute } = prepareChatSendAdmissionContext(params);
  const lifecycleGeneration = getAgentEventLifecycleGeneration();
  const pendingAttemptId = randomUUID();
  const reservation = createPendingChatSendReservationAccess({
    context,
    client,
    attemptId: pendingAttemptId,
    requestIdentity,
    request,
    session,
  });
  const preparedGoalRetry = request.goalOperation
    ? await prepareGoalChatSendRetry(params)
    : undefined;
  const pendingRetry = prepareChatSendAdmissionRetry(params);
  const preparedRetry = pendingRetry instanceof Promise ? await pendingRetry : pendingRetry;
  const clearReservationAndThrow = (error: unknown): never => {
    reservation.clear();
    throw error;
  };
  const reserved = await consumeChatSendCurrent(params, () => {
    params.assertCurrent?.();
    const goalRetry = inspectGoalChatSendRetry({ ...params, prepared: preparedGoalRetry });
    if (goalRetry.kind !== "new") {
      if (goalRetry.kind === "replay") {
        respond(true, { ...goalRetry.receipt, replayed: true }, undefined, cachedMeta);
      }
      return undefined;
    }
    const retryComparison = consumeChatSendAdmissionRetry(params, preparedRetry);
    if (retryComparison === false) {
      return undefined;
    }
    const uploadAdmission = admitChatSendUploads({ params: p, client, context, respond });
    if (!uploadAdmission.ok) {
      return undefined;
    }
    // Keeps the run abortable; admission rejects it once expired or missing, never revives it.
    reservation.reserve();
    return { retryComparison, uploadAdmission };
  }).catch(clearReservationAndThrow);
  if (!reserved) {
    return { ok: false as const };
  }
  let retryComparison = reserved.retryComparison;
  const uploadAdmission = reserved.uploadAdmission;
  const preparedGoalEntry =
    request.goalOperation?.action === "start" && !entry && !requestedSessionId
      ? await prepareChatSendSessionEntry({
          cfg: session.cfg,
          client,
          agentId,
          getRuntimeConfig: context.getRuntimeConfig,
        }).catch(clearReservationAndThrow)
      : undefined;
  let admittedSessionId = preparedGoalEntry?.entry.sessionId ?? backingSessionId ?? clientRunId;
  let expectedActiveReplyOperation: ReplyOperation | undefined;
  let replyTargetsCaptured = false;
  let gatewayWorkAdmission: Awaited<ReturnType<typeof beginSessionEffect>> | undefined;
  let restartSafeAdmission: ReturnType<typeof resolveRestartSafeChatAdmission>;
  let workerGoalAdmission = false;
  let initialSessionEntry: SessionEntry | undefined;
  let admittedSessionEntry: SessionEntry | undefined;
  let admittedSessionSettings: ReturnType<typeof captureAdmittedChatSendSessionSettings>;
  let assertInitialSkillSelection: (() => void) | undefined;
  let messageInjectionTarget: ReplyMessageInjectionTarget | undefined;
  let reservationSuperseded = false;
  let supersedingResult: DedupeEntry | undefined;
  let assertSourceAuthority: (() => void) | undefined = params.assertCurrent;
  const sessionTarget = captureSessionTarget({
    storeScope: storePath,
    sessionKey,
    aliases: [rawSessionKey, session.sessionTarget.storeKey],
    agentId,
    incarnation: admittedSessionId,
  });
  const admittedRunAbort = registerChatAbortController({
    target: sessionTarget,
    policy: resolveQueueSettings({
      cfg,
      channel: originatingRoute.originatingChannel,
      sessionEntry: entry,
      inlineMode: p.queueMode,
    }),
    authority: { assertCurrent: () => assertSourceAuthority?.() },
    runId: clientRunId,
    sessionId: admittedSessionId,
    sessionKey,
    agentId: selectedAgent.agentId,
    timeoutMs,
    ownerConnId: normalizeOptionalString(client?.connId),
    ownerDeviceId: normalizeOptionalString(client?.connect?.device?.id),
    providerId: resolvedSessionModel.provider,
    authProviderId: resolvedSessionAuthProvider,
    resolveTerminalProducer: (active) =>
      resolveActiveReplyRunOwnerForSignal(active.input.abortSignal),
    kind: "chat-send",
    turnKind,
    ...(progressRefresh ? { controlUiVisible: false, projectSessionActive: false } : {}),
    lifecycleGeneration,
  });
  const runInterruptCapture =
    admittedRunAbort.entry?.input.policy.mode === "interrupt"
      ? captureSessionControllerInterruptBefore(admittedRunAbort.entry.input)
      : undefined;
  const placementService = context.workerSessionPlacementService;
  const isPendingReservationCurrent = () => {
    if (context.chatRunState.hasAbortMarker(clientRunId)) {
      return false;
    }
    const currentReservation = reservation.read();
    if (
      currentReservation &&
      normalizeOptionalString(currentReservation.payload.attemptId) !== pendingAttemptId
    ) {
      reservationSuperseded = true;
      return false;
    }
    if (!currentReservation) {
      const terminalResult = readChatSendDedupeResponse(context.dedupe, clientRunId);
      if (
        terminalResult ||
        (admittedRunAbort.entry &&
          !isRpcSourceRegistered(admittedRunAbort.entry) &&
          hasRpcSourceForController(clientRunId, admittedRunAbort.entry))
      ) {
        reservationSuperseded = true;
        supersedingResult = terminalResult;
        return false;
      }
    }
    if (lifecycleGeneration !== getAgentEventLifecycleGeneration()) {
      admittedRunAbort.controller.abort(createAgentRunRestartAbortError());
      reservation.abort("restart");
      return false;
    }
    if (!isFutureDateTimestampMs(currentReservation?.payload.expiresAtMs, { nowMs: Date.now() })) {
      admittedRunAbort.controller.abort("timeout");
      reservation.abort("timeout");
      return false;
    }
    return true;
  };
  const commitChatWorkAdmission = async (
    initialAcp: Awaited<ReturnType<typeof prepareChatSendAcpMetadata>> | null,
    preparedPlacement?: PreparedRestartSafeChatPlacement,
  ): Promise<void> => {
    let acp = initialAcp;
    if (context.workerSessionPlacementService !== placementService) {
      throw new Error("Worker placement owner changed during chat admission; retry.");
    }
    if (
      restartSafeRequest &&
      !context.getRuntimeConfig().cloudWorkers?.requiredProfile &&
      placementService &&
      preparedPlacement?.sessionId !== admittedSessionId
    ) {
      using placementPhase = diagnostics?.scope("detail.admission.placement_prepare");
      return await withRestartSafeChatPlacement(placementService, admittedSessionId, (prepared) => {
        placementPhase?.finish();
        return commitChatWorkAdmission(acp, prepared);
      });
    }
    let refreshPlacement = false;
    for (;;) {
      let pendingPlacementRead: (() => Promise<void>) | undefined;
      let pendingAcpRead: (() => ReturnType<typeof prepareChatSendAcpMetadata>) | undefined;
      using currentPhase = diagnostics?.scope("detail.admission.current_session");
      await withCurrentChatSendRetry(params, pendingAttemptId, (latestSession, comparison) => {
        const currentConfig = context.getRuntimeConfig();
        const localRecovery = restartSafeRequest && !currentConfig.cloudWorkers?.requiredProfile;
        retryComparison = comparison;
        params.assertCurrent?.();
        const retainedRequestConflict = resolveChatSendRequestConflict(
          params,
          retryComparison,
          pendingAttemptId,
        );
        if (retainedRequestConflict) {
          throw new Error(retainedRequestConflict.message);
        }
        if (!isPendingReservationCurrent()) {
          return;
        }
        const latestEntry = latestSession.entry;
        const latestSessionId = latestEntry?.sessionId;
        admittedSessionEntry = latestEntry;
        const requestConflict = resolveChatSendRequestConflict(
          { ...params, session: { ...session, entry: latestEntry } },
          retryComparison,
          pendingAttemptId,
        );
        if (requestConflict) {
          throw new Error(requestConflict.message);
        }
        admittedSessionSettings = captureAdmittedChatSendSessionSettings({
          commit: true,
          entry: latestEntry,
          expectedPermissionMode: p.expectedPermissionMode,
          expectedToolOverrides: p.expectedToolOverrides,
        });
        assertChatSendExclusiveAdmission(request, session);
        if (entry && !latestEntry) {
          throw new Error(`Session "${sessionKey}" was deleted while starting work. Retry.`);
        }
        if (p.queueMode !== "steer" && expectedLeafEntryId !== undefined) {
          assertExpectedLeafActive(latestSession, expectedLeafEntryId, requestedSessionId, {
            allowEmptyAncestor: true,
          });
        }
        // Check the leaf first for typed errors; a reset must never redirect this request.
        const expectedSessionId = requestedSessionId ?? backingSessionId;
        if (expectedSessionId && latestSessionId !== expectedSessionId) {
          throw new Error(`Session "${sessionKey}" changed while starting work. Retry.`);
        }
        pendingAcpRead = prepareChatSendAcpRefresh(params, acp, latestSession);
        if (pendingAcpRead) {
          return;
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
          reservationSuperseded = true;
          supersedingResult = {
            ts: Date.now(),
            ok: true,
            payload: { runId: clientRunId, status: "ok" as const },
          };
          return;
        }
        const archivedError = resolveSessionWorkStartError(sessionKey, latestEntry, {
          allowPendingWorkspace: true,
          restartResume: request.restartResume,
          providerReviewAcknowledgment: request.providerReviewAcknowledgment,
          runId: clientRunId,
        });
        if (archivedError) {
          throw new Error(archivedError);
        }
        admittedSessionId = latestSessionId ?? backingSessionId ?? clientRunId;
        if (!replyTargetsCaptured) {
          // Retain original opaque targets, including absence, across placement waits.
          messageInjectionTarget =
            p.queueMode === "steer"
              ? captureCurrentReplyMessageInjectionTarget(
                  admittedRunAbort.entry?.input.mailbox.owner.id ?? activeRunScopeKey,
                )
              : undefined;
          expectedActiveReplyOperation = admittedRunAbort.entry?.input.mailbox.owner.active;
          replyTargetsCaptured = true;
        }
        if (request.goalOperation?.action === "start" && !latestEntry && !requestedSessionId) {
          const prepared = preparedGoalEntry!;
          initialSessionEntry = prepared.entry;
          assertInitialSkillSelection = prepared.assertSkillSelection;
          admittedSessionId = initialSessionEntry.sessionId;
        }
        if (context.workerSessionPlacementService !== placementService) {
          throw new Error("Worker placement owner changed during chat admission; retry.");
        }
        const placementChanged = preparedPlacement?.sessionId !== admittedSessionId;
        if (localRecovery && placementService && placementChanged) {
          // A fresh Goal needs placement facts outside this synchronous reader.
          refreshPlacement = true;
          return;
        }
        const preparedRead = localRecovery ? preparedPlacement?.facts.prepareRead() : undefined;
        if (preparedRead) {
          pendingPlacementRead = observeChatSendWork(preparedRead);
          return;
        }
        const placement = localRecovery ? preparedPlacement?.facts.current() : undefined;
        const acpMeta = acp?.meta ?? null;
        restartSafeAdmission = resolveRestartSafeChatAdmission({
          resolveGatewayContext: context.resolveGatewayContext,
          agentId,
          cfg: currentConfig,
          clientRunId,
          context,
          entry: latestEntry,
          initialSessionEntry,
          lifecycleTimestamps: latestSession.lifecycleTimestamps,
          acpMeta,
          now: Date.now(),
          placement,
          request: restartSafeRequest,
          requestedSessionId,
          sessionId: admittedSessionId,
          sessionKey: latestSession.canonicalKey,
          storePath: latestSession.storePath,
        });
        workerGoalAdmission = isWorkerGoalChatAdmission(params, latestSession, placement, acpMeta);
        if (request.goalOperation && !restartSafeAdmission && !workerGoalAdmission) {
          throw new Error(
            "Goal start or resume requires an idle built-in local session with recoverable history or a supported Codex cloud-worker session.",
          );
        }
        if (retryableClaim && !restartSafeAdmission) {
          throw new Error("chat retry does not match its durable admission");
        }
      }).catch((error: unknown) => {
        if (isSessionTranscriptProjectionUnavailableError(error)) {
          // Cancellation still owns the outcome when worker preparation cannot finish.
          isPendingReservationCurrent();
        }
        throw error;
      });
      if (pendingAcpRead) {
        currentPhase?.finish();
        acp = await pendingAcpRead();
        continue;
      }
      if (!pendingPlacementRead) {
        break;
      }
      // End row consumption before joining the native writer; retain FIFO and recheck authority.
      currentPhase?.mark("detail.admission.placement_refresh");
      await pendingPlacementRead();
    }
    return refreshPlacement ? commitChatWorkAdmission(acp) : undefined;
  };

  let capturedOperator: Awaited<ReturnType<typeof prepareChatSendInterruptAdmission>>["operator"];
  let releaseCapturedOperator = () => {};
  let interruptedActiveRun = false;
  let retainedRequestConflict: ReturnType<typeof resolveChatSendRequestConflict>;
  try {
    using workPhase = diagnostics?.scope("detail.admission.work");
    using admissionPhase = diagnostics?.scope("detail.admission.operator");
    const preparedInterrupt = await prepareChatSendInterruptAdmission({
      operator: { ...params, runId: clientRunId, spawnedBy: session.entry?.spawnedBy },
      interruptCapture: runInterruptCapture,
      entry: admittedRunAbort.entry,
      assertCurrent: params.assertCurrent,
      assertSessionTargetCurrent,
      abortSignal: admittedRunAbort.controller.signal,
    });
    capturedOperator = preparedInterrupt.operator;
    releaseCapturedOperator = capturedOperator.release;
    admissionPhase?.mark("detail.admission.lifecycle_prepare");
    gatewayWorkAdmission = await beginSessionEffect({
      agentId,
      sourceInput: admittedRunAbort.entry?.input,
      isSettling: () => admittedRunAbort.entry?.adapter.terminalOutcomeObserved === true,
      target: sessionTarget,
      storeWriterIdentities: [sessionKey, session.sessionTarget.storeKey],
      assertAllowed: () => {
        params.assertCurrent?.();
        assertSessionTargetCurrent();
        assertChatSendExclusiveAdmission(request, session);
      },
      revalidateAllowed: async () => {
        admissionPhase?.finish();
        using _ = diagnostics?.scope("detail.admission.revalidate");
        if (!restartSafeRequest) {
          return await commitChatWorkAdmission(null);
        }
        return await commitChatWorkAdmission(await prepareChatSendAcpMetadata(params));
      },
      onInterrupt: (reason) => {
        admittedRunAbort.controller.abort(reason);
      },
    });
    if (workerGoalAdmission && !capturedOperator.authority) {
      throw new Error("Worker Goals require a current authenticated operator request.");
    }
    admittedRunAbort.initializeTiming({ now: Date.now(), timeoutMs });
    workPhase?.finish();
    if (
      admittedRunAbort.controller.signal.aborted &&
      !readChatSendDedupeResponse(context.dedupe, clientRunId)
    ) {
      reservation.abort(admittedRunAbort.entry?.adapter.abortStopReason ?? "rpc");
    }
    admittedRunAbort.controller.signal.throwIfAborted();
    params.assertCurrent?.();
    retainedRequestConflict = await consumeChatSendCurrent(params, () =>
      resolveChatSendRequestConflict(params, retryComparison, pendingAttemptId),
    );
    if (
      runInterruptCapture &&
      !retainedRequestConflict &&
      !reservationSuperseded &&
      isPendingReservationCurrent() &&
      admittedRunAbort.registered
    ) {
      interruptedActiveRun = preparedInterrupt.interrupt();
    }
  } catch (err) {
    const pendingReservationAtFailure = reservation.read();
    reservation.clear();
    admittedRunAbort.cleanup();
    gatewayWorkAdmission?.release();
    releaseCapturedOperator();
    respondChatSendWorkAdmissionFailure(
      params,
      err,
      {
        attemptId: pendingAttemptId,
        lifecycleGeneration,
        pendingReservation: pendingReservationAtFailure,
        requestIdentity,
        runAbort: admittedRunAbort,
      },
      retryComparison,
    );
    return { ok: false as const };
  }
  if (retainedRequestConflict) {
    reservation.clear();
    admittedRunAbort.cleanup();
    gatewayWorkAdmission.release();
    capturedOperator.release();
    respond(false, undefined, retainedRequestConflict);
    return { ok: false as const };
  }
  if (
    admittedRunAbort?.registered &&
    !reservationSuperseded &&
    !readChatSendDedupeResponse(context.dedupe, clientRunId)
  ) {
    // Transfer immutable input identity before retiring the pending reservation.
    // It survives transient pre-ACK failures without inventing a successful response.
    context.dedupe.set(`chat:${clientRunId}`, {
      ts: Date.now(),
      ok: true,
      requestIdentity,
    });
  }
  reservation.clear();
  const releaseAdmissionOwners = () => {
    gatewayWorkAdmission.release();
    capturedOperator.release();
  };
  if (reservationSuperseded) {
    admittedRunAbort.cleanup();
    releaseAdmissionOwners();
    const supersedingCached =
      supersedingResult ?? readChatSendDedupeResponse(context.dedupe, clientRunId);
    if (supersedingCached) {
      respond(supersedingCached.ok, supersedingCached.payload, supersedingCached.error, cachedMeta);
      return { ok: false as const };
    }
    respond(true, { runId: clientRunId, status: "in_flight" as const }, undefined, cachedMeta);
    return { ok: false as const };
  }
  if (lifecycleGeneration !== getAgentEventLifecycleGeneration()) {
    if (admittedRunAbort.entry) {
      admittedRunAbort.entry.adapter.abortStopReason = "restart";
    }
    admittedRunAbort.controller.abort();
    admittedRunAbort.cleanup();
    releaseAdmissionOwners();
    if (!readChatSendDedupeResponse(context.dedupe, clientRunId)) {
      reservation.abort(admittedRunAbort.entry?.adapter.abortStopReason ?? "restart");
    }
    const aborted = readChatSendDedupeResponse(context.dedupe, clientRunId);
    respond(aborted?.ok ?? true, aborted?.payload, aborted?.error, cachedMeta);
    return { ok: false as const };
  }
  if (!admittedRunAbort.registered) {
    releaseAdmissionOwners();
    respond(true, { runId: clientRunId, status: "in_flight" as const }, undefined, cachedMeta);
    return { ok: false as const };
  }
  assertSourceAuthority = () => {
    capturedOperator.authority?.assertCurrent();
    assertSessionTargetCurrent();
    if (!gatewayWorkAdmission?.isActive()) {
      throw new Error("Chat source preparation custody ended");
    }
  };
  const dispatchCustody = await prepareAdmittedChatSendDispatch({
    params,
    assertSessionTargetCurrent,
    runAbort: admittedRunAbort,
    admission: gatewayWorkAdmission,
    releaseCaller: () => {
      try {
        releaseChatSendCallerAuthority({ operator: capturedOperator, request });
      } finally {
        session.releaseSessionStorage?.();
      }
    },
  });
  if (!dispatchCustody) {
    return { ok: false as const };
  }
  const { releaseCallerAuthority, releaseGatewayRootContinuation } = dispatchCustody;

  const acquiredGatewayWorkAdmission = gatewayWorkAdmission;
  const sourceRef = admittedRunAbort.entry;
  let sessionPreparationActive = true;
  const onSessionPrepared = bindChatSendPreparedSession({
    runId: clientRunId,
    sessionKey,
    sourceRef,
    lifecycleGeneration,
    admission: {
      isActive: () => sessionPreparationActive && acquiredGatewayWorkAdmission.isActive(),
    },
  });
  const retainedWork = createChatSendWorkAdmission({
    admission: acquiredGatewayWorkAdmission,
    followRegistration: params.followRegistration,
    releaseCallerAuthority,
    releaseGatewayRootContinuation,
    logGateway: context.logGateway,
    terminal: {
      target: session.sessionTarget,
      storePath,
      sourceRef,
      admittedSessionId,
      runId: clientRunId,
      lifecycleRevision: (admittedSessionEntry ?? initialSessionEntry)?.lifecycleRevision,
      isActive: () => acquiredGatewayWorkAdmission.isActive(),
      currentRegistration: () => (isRpcSourceRegistered(sourceRef) ? sourceRef : undefined),
    },
  });
  // Abandoned preparation discards media only while no transcript or pending
  // input retains it. Dispatch disarms this cleanup before taking custody, so
  // admission cleanup cannot race its persistence or final media disposal.
  const { cleanup: cleanupAdmittedRun, setDiscardPreparedMedia } = createAdmittedChatSendCleanup({
    cleanupAbort: () => {
      sessionPreparationActive = false;
      admittedRunAbort.cleanup();
    },
    releaseRetainedWork: retainedWork.release,
  });
  const rejectSessionRoutingChanged = () => {
    cleanupAdmittedRun();
    clearAgentRunContext(clientRunId, lifecycleGeneration);
    respondChatSessionRoutingChanged(respond);
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
      activeRunAbort: admittedRunAbort,
      operatorAuthority: capturedOperator.authority,
      armOperatorRunCancellation: capturedOperator.armCancellation,
      retireOperatorRunCancellation: capturedOperator.retireCancellation,
      admittedSessionSettings,
      admittedSessionId,
      ...(expectedActiveReplyOperation ? { expectedActiveReplyOperation } : {}),
      sourceRef,
      onSessionPrepared,
      initialSessionEntry,
      admittedSessionEntry,
      chatSendTraceAttributes,
      assertInitialSkillSelection,
      cleanupAdmittedRun,
      finishAbortedChatSend: () =>
        publishAbortedChatSend({
          context,
          respond,
          runId: clientRunId,
          lifecycleGeneration,
          stopReason: admittedRunAbort.entry?.adapter.abortStopReason,
          sourceRef,
          cleanup: cleanupAdmittedRun,
        }),
      gatewayWorkAdmission,
      lifecycleGeneration,
      markInputAccepted: reservation.markInputAccepted,
      interruptedActiveRun,
      messageInjectionTarget,
      originatingRoute,
      rejectSessionRoutingChanged,
      releaseSourceWorkAdmission: retainedWork.release,
      retainGatewayWorkAdmission: retainedWork.retain,
      settleTerminal: retainedWork.settleTerminal,
      withInputCommitPublication: retainedWork.withInputCommitPublication,
      acquireInputActor: () => retainedWork.acquireInputActor(),
      setPendingInputCleanup: retainedWork.setPendingInputCleanup,
      assertClientUploadAllowed: uploadAdmission.assertClientUploadAllowed,
      assertWorkAdmissionCurrent: () =>
        assertChatSendWorkAdmissionCurrent({
          retainedWork,
          admission: acquiredGatewayWorkAdmission,
          lifecycleGeneration,
          controller: admittedRunAbort.controller,
          sourceRef,
        }),
      restartSafeAdmission,
      workerGoalAdmission,
      setDiscardAbandonedPreparedMedia: setDiscardPreparedMedia,
    },
  };
}

type ChatSendAdmissionResult = Awaited<ReturnType<typeof admitChatSend>>;
export type AdmittedChatSend = Extract<ChatSendAdmissionResult, { ok: true }>["value"];
