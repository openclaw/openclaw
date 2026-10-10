import { randomUUID } from "node:crypto";
import { isFutureDateTimestampMs } from "@openclaw/normalization-core/number-coercion";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import { readAcpSessionMetaForEntries } from "../../acp/runtime/session-meta-readonly.js";
import { isAgentRunRestartAbortReason } from "../../agents/run-termination.js";
import {
  isReplyRunAbortableForSignal,
  replyRunRegistry,
  type ReplyMessageInjectionTarget,
  type ReplyOperation,
} from "../../auto-reply/reply/reply-run-registry.js";
import { resolveActiveReplyRunOwnerForSignal } from "../../auto-reply/reply/reply-run-registry.state.js";
import { resolveSessionWorkStartError } from "../../config/sessions.js";
import {
  hasRestartRecoveryTerminalRun,
  isRetryableUnadoptedChatClaim,
} from "../../config/sessions/restart-recovery-state.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { claimAgentRunContext, clearAgentRunContext } from "../../infra/agent-run-registry.js";
import { retainGatewayRootWorkAdmissionContinuation } from "../../process/gateway-work-admission.js";
import {
  isProgressCardRefreshInputProvenance,
  progressCardRefreshRunProjection,
} from "../../sessions/input-provenance.js";
import { beginSessionWorkAdmission } from "../../sessions/session-lifecycle-admission.js";
import { registerChatAbortController } from "../chat-abort.js";
import { retainGatewayOperatorRun } from "../operator-run-cancellation.js";
import type { DedupeEntry } from "../server-shared.js";
import { writePreRegisteredChatAbort } from "./chat-abort-authorization.js";
import {
  resolveRestartSafeChatAdmission,
  withRestartSafeChatPlacement,
  type PreparedRestartSafeChatPlacement,
} from "./chat-restart-recovery.js";
import { assertExpectedLeafActive } from "./chat-send-active-leaf.js";
import {
  createAdmittedChatSendCleanup,
  finishAbortedChatSend,
} from "./chat-send-admission-cleanup.js";
import {
  assertChatSendSessionTargetOrRespond,
  prepareChatSendAdmissionContext,
} from "./chat-send-admission-context.js";
import { prepareGoalChatSendRetry } from "./chat-send-goal-retry.js";
import {
  resolveChatSendRequestConflict,
  consumeChatSendCurrent,
  respondChatSessionRoutingChanged,
} from "./chat-send-pre-admission.js";
import type { ChatSendAdmissionParams } from "./chat-send-pre-admission.types.js";
import {
  createPendingChatSendReservationAccess,
  inspectGoalChatSendRetry,
  readChatSendDedupeResponse,
} from "./chat-send-reservation.js";
import { bindChatSendPreparedSession } from "./chat-send-session-binding.js";
import { captureAdmittedChatSendSessionSettings } from "./chat-send-session-settings.js";
import { withCurrentChatSendSession, prepareChatSendSessionEntry } from "./chat-send-session.js";
import {
  admitChatSendUploads,
  assertChatSendExclusiveAdmission,
  createChatSendWorkAdmission,
  consumeChatSendAdmissionRetry,
  prepareChatSendAdmissionRetry,
  withCurrentChatSendRetry,
  releaseChatSendCallerAuthority,
  observeChatSendWork,
  interruptChatSendWork,
  respondChatSendWorkAdmissionFailure,
} from "./chat-send-work-admission.js";

/** Reserve the session lifecycle and register the abortable run before attachment work. */
export async function admitChatSend(params: ChatSendAdmissionParams) {
  const { request, session, respond, context, client } = params;
  const { p, turnKind } = request;
  const requestIdentity = request.goalOperation?.requestFingerprint ?? request.requestIdentity;
  const progressRefresh = isProgressCardRefreshInputProvenance(request.systemInputProvenance);
  const {
    clientRunId,
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
  const cachedMeta = { cached: true, runId: clientRunId };
  const assertSessionTargetCurrent = session.assertSessionTargetCurrent;
  const { chatSendTraceAttributes, originatingRoute } = prepareChatSendAdmissionContext(params);
  const lifecycleGeneration = getAgentEventLifecycleGeneration();
  const pendingAttemptId = randomUUID();
  const pendingReservation = createPendingChatSendReservationAccess({
    context,
    client,
    attemptId: pendingAttemptId,
    request,
    session,
  });
  const preparedGoalRetry = request.goalOperation
    ? await prepareGoalChatSendRetry(params)
    : undefined;
  const pendingRetry = prepareChatSendAdmissionRetry(params);
  const preparedRetry = pendingRetry instanceof Promise ? await pendingRetry : pendingRetry;
  const reserve = () => {
    params.assertCurrent?.();
    assertSessionTargetCurrent();
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
    params.assertCurrent?.();
    pendingReservation.reserve();
    return { retryComparison, uploadAdmission };
  };
  const reserved = await consumeChatSendCurrent(params, reserve).catch((error: unknown) => {
    pendingReservation.clear();
    throw error;
  });
  if (!reserved) {
    return { ok: false as const };
  }
  let retryComparison = reserved.retryComparison;
  const uploadAdmission = reserved.uploadAdmission;
  const abortPendingChatSend = (stopReason: string) =>
    writePreRegisteredChatAbort({
      context,
      runId: clientRunId,
      stopReason,
      attemptId: pendingAttemptId,
      requestIdentity,
    });
  let admittedSessionId = backingSessionId ?? clientRunId;
  let expectedActiveReplyOperation: ReplyOperation | undefined;
  let gatewayWorkAdmission: Awaited<ReturnType<typeof beginSessionWorkAdmission>> | undefined;
  let admittedRunAbort: ReturnType<typeof registerChatAbortController> | undefined;
  let restartSafeAdmission: ReturnType<typeof resolveRestartSafeChatAdmission>;
  let initialSessionEntry: SessionEntry | undefined;
  let admittedSessionEntry: SessionEntry | undefined;
  let admittedSessionSettings: ReturnType<typeof captureAdmittedChatSendSessionSettings>;
  let assertInitialSkillSelection: (() => void) | undefined;
  let messageInjectionTarget: ReplyMessageInjectionTarget | undefined;
  let runInterruptTarget: ReturnType<typeof replyRunRegistry.resolveCurrentInterruptTarget>;
  let reservationSuperseded = false;
  let supersedingResult: DedupeEntry | undefined;
  let preparedGoalEntry: Awaited<ReturnType<typeof prepareChatSendSessionEntry>> | undefined;
  const placementService = context.workerSessionPlacementService;
  const commitChatWorkAdmission = async (
    acpMeta: SessionEntry["acp"] | null,
    preparedPlacement?: PreparedRestartSafeChatPlacement,
  ): Promise<void> => {
    if (context.workerSessionPlacementService !== placementService) {
      throw new Error("Worker placement owner changed during chat admission; retry.");
    }
    if (placementService && preparedPlacement?.sessionId !== admittedSessionId) {
      return withRestartSafeChatPlacement(placementService, admittedSessionId, (prepared) =>
        commitChatWorkAdmission(acpMeta, prepared),
      );
    }
    if (
      request.goalOperation?.action === "start" &&
      !entry &&
      !requestedSessionId &&
      !preparedGoalEntry
    ) {
      preparedGoalEntry = await prepareChatSendSessionEntry({
        cfg: session.cfg,
        client,
        agentId,
        getRuntimeConfig: context.getRuntimeConfig,
      });
    }
    let refreshPlacement = false;
    await withCurrentChatSendRetry(params, pendingAttemptId, (latestSession, comparison) => {
      retryComparison = comparison;
      params.assertCurrent?.();
      const retainedRequestConflict = resolveChatSendRequestConflict(params, retryComparison);
      if (retainedRequestConflict) {
        throw new Error(retainedRequestConflict.message);
      }
      if (context.chatRunState.hasAbortMarker(clientRunId)) {
        return;
      }
      const currentReservation = pendingReservation.read();
      if (
        currentReservation &&
        normalizeOptionalString(currentReservation.payload.attemptId) !== pendingAttemptId
      ) {
        reservationSuperseded = true;
        return;
      }
      if (!currentReservation) {
        const terminalResult = readChatSendDedupeResponse(context.dedupe, clientRunId);
        if (terminalResult || context.chatAbortControllers.has(clientRunId)) {
          reservationSuperseded = true;
          supersedingResult = terminalResult;
          return;
        }
      }
      if (lifecycleGeneration !== getAgentEventLifecycleGeneration()) {
        abortPendingChatSend("restart");
        return;
      }
      if (
        !currentReservation ||
        !isFutureDateTimestampMs(currentReservation.payload.expiresAtMs, { nowMs: Date.now() })
      ) {
        abortPendingChatSend("timeout");
        return;
      }
      const latestEntry = latestSession.entry;
      admittedSessionEntry = latestEntry;
      const requestConflict = resolveChatSendRequestConflict(
        { ...params, session: { ...session, entry: latestEntry } },
        retryComparison,
      );
      if (requestConflict) {
        throw new Error(requestConflict.message);
      }
      // Freeze the writer-barrier snapshot; later preparation must retain this authority.
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
      // Capture the exact direct owner under the writer barrier. If it clears
      // later, the opaque target rejects instead of resolving a successor.
      messageInjectionTarget =
        p.queueMode === "steer"
          ? replyRunRegistry.resolveCurrentMessageInjectionTarget(activeRunScopeKey)
          : undefined;
      runInterruptTarget =
        p.queueMode === "interrupt"
          ? replyRunRegistry.resolveCurrentInterruptTarget(activeRunScopeKey)
          : undefined;
      if (p.queueMode !== "steer" && expectedLeafEntryId !== undefined) {
        assertExpectedLeafActive(latestSession, agentId, expectedLeafEntryId, requestedSessionId, {
          allowEmptyAncestor: true,
        });
      }
      // Admission can queue behind reset. Never route a request captured
      // against the old session into the replacement transcript. Check the expected
      // leaf first so branch rotation retains its typed error.
      if (
        backingSessionId &&
        latestEntry?.sessionId &&
        latestEntry.sessionId !== backingSessionId
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
        providerReviewAcknowledgment: request.providerReviewAcknowledgment,
        runId: clientRunId,
      });
      if (archivedError) {
        throw new Error(archivedError);
      }
      admittedSessionId = latestEntry?.sessionId ?? backingSessionId ?? clientRunId;
      // Retain compaction lineage before attachment/context preparation can outlive this owner.
      expectedActiveReplyOperation = replyRunRegistry.get(activeRunScopeKey);
      if (request.goalOperation?.action === "start" && !latestEntry && !requestedSessionId) {
        const prepared = preparedGoalEntry!;
        initialSessionEntry = prepared.entry;
        assertInitialSkillSelection = prepared.assertSkillSelection;
        admittedSessionId = initialSessionEntry.sessionId;
      }
      if (context.workerSessionPlacementService !== placementService) {
        throw new Error("Worker placement owner changed during chat admission; retry.");
      }
      if (placementService && preparedPlacement?.sessionId !== admittedSessionId) {
        // A fresh Goal can select a new incarnation. Release this synchronous
        // reader before awaiting placement facts and rechecking admission.
        refreshPlacement = true;
        return;
      }
      preparedPlacement?.facts.assertCurrent();
      restartSafeAdmission = resolveRestartSafeChatAdmission({
        activeRunScopeKey,
        agentId,
        cfg: latestSession.cfg,
        clientRunId,
        context,
        entry: latestEntry,
        initialSessionEntry,
        lifecycleTimestamps: latestSession.lifecycleTimestamps,
        acpMeta,
        now: Date.now(),
        placement: preparedPlacement?.facts.placement,
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
        ownerConnId: normalizeOptionalString(client?.connId),
        ownerDeviceId: normalizeOptionalString(client?.connect?.device?.id),
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
    });
    if (refreshPlacement) {
      return commitChatWorkAdmission(acpMeta);
    }
  };

  let retainedRequestConflict: ReturnType<typeof resolveChatSendRequestConflict>;
  try {
    gatewayWorkAdmission = await beginSessionWorkAdmission({
      scope: storePath,
      isSettling: () => admittedRunAbort?.entry?.terminalOutcomeObserved === true,
      identities: [sessionKey, backingSessionId],
      storeWriterIdentities: [sessionKey, session.sessionTarget.storeKey],
      assertAllowed: () =>
        consumeChatSendCurrent(params, () => {
          assertSessionTargetCurrent();
          assertChatSendExclusiveAdmission(request, session);
        }),
      revalidateAllowed: async () => {
        if (!restartSafeRequest) {
          return commitChatWorkAdmission(null);
        }
        const latest = await withCurrentChatSendSession({
          session,
          getRuntimeConfig: context.getRuntimeConfig,
          includeMembership: false,
          consume: (current) => current,
        });
        const [acpMeta] = await readAcpSessionMetaForEntries({
          cfg: latest.cfg,
          entries: [{ agentId, sessionKey: latest.canonicalKey, entry: latest.entry }],
        });
        // The writer barrier retains the selected row; commit rechecks request and run authority.
        return commitChatWorkAdmission(acpMeta ?? null);
      },
      onInterrupt: (reason) => {
        const stopReason = isAgentRunRestartAbortReason(reason) ? "restart" : "rpc";
        if (!admittedRunAbort) {
          if (!context.chatRunState.hasAbortMarker(clientRunId)) {
            abortPendingChatSend(stopReason);
          }
        } else if (!admittedRunAbort.controller.signal.aborted) {
          // A later lifecycle drain must not overwrite the first abort reason.
          if (admittedRunAbort.entry) {
            admittedRunAbort.entry.abortStopReason = stopReason;
          }
          admittedRunAbort.controller.abort(reason);
        }
      },
    });
    retainedRequestConflict = await consumeChatSendCurrent(params, () =>
      resolveChatSendRequestConflict(params, retryComparison),
    );
  } catch (err) {
    pendingReservation.clear();
    admittedRunAbort?.cleanup();
    gatewayWorkAdmission?.release();
    respondChatSendWorkAdmissionFailure(params, err, retryComparison);
    return { ok: false as const };
  }
  if (retainedRequestConflict) {
    pendingReservation.clear();
    admittedRunAbort?.cleanup();
    gatewayWorkAdmission.release();
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
  pendingReservation.clear();
  const activeRunAbort = admittedRunAbort;
  if (reservationSuperseded) {
    gatewayWorkAdmission.release();
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
    if (activeRunAbort) {
      if (activeRunAbort.entry) {
        activeRunAbort.entry.abortStopReason = "restart";
      }
      activeRunAbort.controller.abort();
      activeRunAbort.cleanup();
    }
    gatewayWorkAdmission.release();
    if (!readChatSendDedupeResponse(context.dedupe, clientRunId)) {
      abortPendingChatSend(activeRunAbort?.entry?.abortStopReason ?? "restart");
    }
    const aborted = readChatSendDedupeResponse(context.dedupe, clientRunId);
    respond(aborted?.ok ?? true, aborted?.payload, aborted?.error, cachedMeta);
    return { ok: false as const };
  }
  if (!activeRunAbort) {
    gatewayWorkAdmission.release();
    const aborted = readChatSendDedupeResponse(context.dedupe, clientRunId);
    if (aborted) {
      respond(aborted.ok, aborted.payload, aborted.error, cachedMeta);
      return { ok: false as const };
    }
    respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, "chat run admission failed"));
    return { ok: false as const };
  }
  if (!activeRunAbort.registered) {
    gatewayWorkAdmission.release();
    respond(true, { runId: clientRunId, status: "in_flight" as const }, undefined, cachedMeta);
    return { ok: false as const };
  }
  const acquiredGatewayWorkAdmission = gatewayWorkAdmission;
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
  let startedWork: (() => Promise<unknown>) | undefined;
  const startOwnedWork = <T>(work: Promise<T>) => {
    const observed = observeChatSendWork(work);
    startedWork = observed;
    return observed;
  };
  try {
    capturedOperator = await retainGatewayOperatorRun({
      ...params,
      runId: clientRunId,
      entry: activeRunAbort.entry,
    });
    releaseCallerAuthority = () =>
      releaseChatSendCallerAuthority({ operator: capturedOperator, request, session });
    // Authority stays fresh per segment; effects check cancellation themselves.
    // A cancelled admission callback must still reach the handler's abort settlement.
    const consumeCurrent = <T>(consume: () => T): Promise<T | undefined> =>
      consumeChatSendCurrent(params, () => {
        capturedOperator.authority?.assertCurrent();
        if (
          !assertChatSendSessionTargetOrRespond({
            session,
            cleanup: cleanupPreDispatchAdmission,
            respond,
          })
        ) {
          return undefined;
        }
        return consume();
      });
    if (runInterruptTarget || p.queueMode === "interrupt") {
      const pending = await consumeCurrent(() => ({
        interruption: startOwnedWork(
          interruptChatSendWork({
            target: runInterruptTarget,
            signal: activeRunAbort.controller.signal,
            admission: acquiredGatewayWorkAdmission,
            storePath,
            identities: [sessionKey, backingSessionId, admittedSessionId],
          }),
        ),
      }));
      if (!pending) {
        return { ok: false as const };
      }
      const interruption = await pending.interruption();
      interruptedActiveRun = interruption.interrupted;
      if (!interruption.settled) {
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
    }
    const pending = await consumeCurrent(() => {
      activeRunAbort.controller.signal.throwIfAborted();
      // Detached dispatch retains the request root until terminal persistence.
      releaseGatewayRootContinuation = retainGatewayRootWorkAdmissionContinuation() ?? (() => {});
      return {
        admission: params.onAdmissionOwned
          ? startOwnedWork(acquiredGatewayWorkAdmission.run(params.onAdmissionOwned))
          : undefined,
      };
    });
    if (!pending) {
      return { ok: false as const };
    }
    if (pending.admission) {
      if (!(await pending.admission())) {
        cleanupPreDispatchAdmission();
        return { ok: false as const };
      }
      if (!(await consumeCurrent(() => true))) {
        return { ok: false as const };
      }
    }
  } catch (error) {
    // Reader cleanup may reject after starting effects. Join them before releasing
    // custody, preserving the original authority failure without replaying work.
    if (startedWork) {
      await Promise.allSettled([startedWork()]);
    }
    cleanupPreDispatchAdmission();
    throw error;
  }

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
    releaseGatewayRootContinuation,
    logGateway: context.logGateway,
    terminal: {
      target: session.sessionTarget,
      storePath,
      sessionBinding,
      admittedSessionId,
      runId: clientRunId,
      lifecycleRevision: (admittedSessionEntry ?? initialSessionEntry)?.lifecycleRevision,
      isActive: acquiredGatewayWorkAdmission.isActive,
      currentRegistration: () => context.chatAbortControllers.get(clientRunId),
    },
  });
  // Prepared inbound media has no transcript reference until the user turn
  // persists; every abandonment exit funnels through cleanupAdmittedRun, so
  // the armed discard here is the single custody owner for that window. The
  // handler disarms it once the media becomes referenced (durable admission
  // or ACK handing ownership to dispatch, which persists on all paths).
  const { cleanup: cleanupAdmittedRun, setDiscardPreparedMedia } = createAdmittedChatSendCleanup({
    cleanupAbort: activeRunAbort.cleanup,
    releaseRetainedWork: retainedWork.release,
  });
  const rejectSessionRoutingChanged = () => {
    cleanupAdmittedRun();
    clearAgentRunContext(clientRunId, lifecycleGeneration);
    respondChatSessionRoutingChanged(respond);
  };
  const finishAborted = () =>
    finishAbortedChatSend({
      context,
      respond,
      runId: clientRunId,
      lifecycleGeneration,
      stopReason: activeRunAbort.entry?.abortStopReason,
      sessionBinding,
      cleanup: cleanupAdmittedRun,
    });
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
      admittedSessionEntry,
      chatSendTraceAttributes,
      assertInitialSkillSelection,
      assertSessionTargetCurrent,
      cleanupAdmittedRun,
      finishAbortedChatSend: finishAborted,
      gatewayWorkAdmission,
      lifecycleGeneration,
      interruptedActiveRun,
      messageInjectionTarget,
      originatingRoute,
      rejectSessionRoutingChanged,
      releaseSourceWorkAdmission: retainedWork.release,
      retainGatewayWorkAdmission: retainedWork.retain,
      settleTerminal: retainedWork.settleTerminal,
      withInputCommitPublication: retainedWork.withInputCommitPublication,
      setPendingInputCleanup: retainedWork.setPendingInputCleanup,
      assertClientUploadAllowed: uploadAdmission.assertClientUploadAllowed,
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
      setDiscardAbandonedPreparedMedia: setDiscardPreparedMedia,
    },
  };
}

type ChatSendAdmissionResult = Awaited<ReturnType<typeof admitChatSend>>;
export type AdmittedChatSend = Extract<ChatSendAdmissionResult, { ok: true }>["value"];
