import { performance } from "node:perf_hooks";
import {
  createAgentRunRestartAbortError,
  isAgentRunRestartAbortReason,
} from "../../agents/run-termination.js";
import { reserveReplyAdmissionTicket } from "../../auto-reply/reply/reply-admission-ticket.js";
import { lookupSessionGoalOperation } from "../../config/sessions/goals-operations-read.js";
import type {
  SessionGoalOperation,
  SessionGoalOperationResult,
} from "../../config/sessions/goals-operations.js";
import { composeSessionSourceAssertion } from "../../config/sessions/session-source-authority.js";
import { logVerbose } from "../../globals.js";
import { getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { clearAgentRunContext } from "../../infra/agent-run-registry.js";
import { emitDiagnosticsTimelineEvent } from "../../infra/diagnostics-timeline.js";
import { formatErrorMessage } from "../../infra/errors.js";
// chat.send owns admission, ACK timing, and detached dispatch handoff.
import { isProgressCardRefreshInputProvenance } from "../../sessions/input-provenance.js";
import {
  retireProviderReviewAcknowledgment,
  type ProviderReviewAcknowledgment,
} from "../../sessions/provider-review.js";
import { recordSessionCreated } from "../../sessions/session-created.js";
import type { PersistedUserTurnMessage } from "../../sessions/user-turn-transcript.js";
import { extractTextFromChatContent } from "../../shared/chat-content.js";
import { createLazyImportLoader } from "../../shared/lazy-promise.js";
import { resolveChatAbortDiagnosticReason } from "../chat-abort-diagnostics.js";
import { invalidateSkillAuthoringForOtherRequester } from "../skill-library-authoring.js";
import type { RestartSafeChatTerminalState } from "./chat-restart-recovery.js";
import { startChatDispatch } from "./chat-send-agent-dispatch.js";
import {
  bindChatSendPreparedMediaCustody,
  prepareChatSendAttachments,
} from "./chat-send-attachments.js";
import { createChatSendDashboardAuthority } from "./chat-send-dashboard-authority.js";
import { readChatSendDiagnostics, startChatSendDiagnostics } from "./chat-send-diagnostics.js";
import { handleChatSendSetupError } from "./chat-send-dispatch-errors.js";
import type { ChatSendExternalAuthorityAdmission } from "./chat-send-external-authority-contract.js";
import {
  createChatSendMessageInjectionStarter,
  settleChatSendPreAckMessageInjection,
} from "./chat-send-message-injection.js";
import type { ChatSendInternalOptions } from "./chat-send-options.js";
import { applyChatSendReplyContextFields } from "./chat-send-reply-context.js";
import { createChatSendSessionInitialization } from "./chat-send-session-binding.js";
import { prepareAndAdmitChatSend } from "./chat-send-setup.js";
import { prepareChatSendUserTurn } from "./chat-send-user-turn.js";
import {
  createChatSendGoalCommitGuard,
  createChatSendPendingInputAdmission,
} from "./chat-send-work-admission.js";
import { prepareChatSendAckTiming } from "./chat-server-timing.js";
import { createGatewayChatUserTurnController } from "./chat-user-turn-recorder.js";
import { isDirectGatewayUserClient } from "./cron-creator-authority-admission.js";
import { gatewayClientSessionCreator } from "./gateway-client-identity.js";
import { emitSessionsChanged } from "./session-change-event.js";
import { publishCommittedSessionGoalChange } from "./session-goal-change.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

const mediaDocumentContextLoader = createLazyImportLoader(
  () => import("../../media-understanding/file-context.js"),
);

async function handleChatSendWithOptions(
  handlerOptions: GatewayRequestHandlerOptions,
  onAdmissionOwned?: () => Promise<boolean>,
  externalAuthorityAdmission?: ChatSendExternalAuthorityAdmission,
  options?: ChatSendInternalOptions,
): Promise<void> {
  const {
    req,
    respond,
    context,
    client,
    hasCurrentClientAuthority,
    sessionMutationAuthorization,
    sessionMutationCommitGuard,
  } = handlerOptions;
  const releaseSessionAuthorization =
    sessionMutationAuthorization?.takeRelease?.() ?? sessionMutationAuthorization?.release;
  using diagnostics =
    readChatSendDiagnostics(handlerOptions) ?? startChatSendDiagnostics(context.logGateway);
  const isDirectExternalUser =
    externalAuthorityAdmission !== undefined && isDirectGatewayUserClient(client);
  const setup = await prepareAndAdmitChatSend(
    handlerOptions,
    onAdmissionOwned,
    { ...options, isDirectExternalUser },
    diagnostics,
  ).catch((error: unknown) => {
    releaseSessionAuthorization?.();
    throw error;
  });
  if (!setup) {
    releaseSessionAuthorization?.();
    return;
  }
  const { request, session, admission } = setup;
  admission.setPendingInputCleanup(() => releaseSessionAuthorization?.());
  using admittedCleanup = {
    dispatched: false,
    [Symbol.dispose]() {
      if (!this.dispatched) {
        admission.cleanupAdmittedRun();
      }
    },
  };
  const { p, systemInputProvenance, reconnectResumeRequested } = request;
  const { clientRunId, cfg, storePath, entry, sessionKey, sessionRoutingChanged, selectedAgent } =
    session;
  const {
    activeRunAbort,
    admittedSessionId,
    chatSendTraceAttributes,
    finishAbortedChatSend,
    interruptedActiveRun,
    lifecycleGeneration,
    messageInjectionTarget,
    restartSafeAdmission,
  } = admission;
  const phase = diagnostics.scope("attachments");
  const preparedAttachments = await prepareChatSendAttachments({
    ...setup,
    client,
    respond,
    context,
  });
  if (!preparedAttachments.ok) {
    return;
  }
  const bindPreparedMediaRecorder = bindChatSendPreparedMediaCustody({
    admission,
    attachments: preparedAttachments.value,
  });
  const settleInterruptedPreparation = () => {
    if (activeRunAbort.controller.signal.aborted) {
      finishAbortedChatSend();
    } else if (sessionRoutingChanged(context.getRuntimeConfig())) {
      admission.rejectSessionRoutingChanged();
    } else {
      return false;
    }
    return true;
  };
  // Attachment preparation can suspend; settle cancellation before the synchronous ACK path.
  if (settleInterruptedPreparation()) {
    return;
  }
  const { imageOrder, prepareAttachmentsMs } = preparedAttachments.value;
  phase?.mark("authority");
  const externalAdmissionParams = {
    runId: clientRunId,
    sessionKey,
    spawnedBy: entry?.spawnedBy,
    client,
    isCurrent: hasCurrentClientAuthority,
    inputProvenance: systemInputProvenance,
    hasExplicitOrigin: request.explicitOrigin !== undefined,
    hasRestoredCronContinuation: entry?.cronRunContinuation !== undefined,
    isIncognitoEntry: entry?.incognito === true,
    isReconnectResume: reconnectResumeRequested,
    isSystemGenerated:
      request.suppressCommandInterpretation || request.systemProvenanceReceipt !== undefined,
    turnKind: request.turnKind,
  };
  const cronCreatorAuthority = externalAuthorityAdmission?.resolve(externalAdmissionParams);

  const admissionStartedAt = Date.now();
  const terminalizeRestartSafeAdmission = (terminalState: RestartSafeChatTerminalState) =>
    admission.settleTerminal({ ...terminalState, startedAt: admissionStartedAt });
  // sessions.create invokes chat only after committing a fresh session. Its eligible
  // initial input transfers custody with the transcript and restart claim, not before.
  const commitFreshInput =
    restartSafeAdmission !== undefined && !restartSafeAdmission.retryExpectedState;
  const commitInitialInput = req.method === "sessions.create" && commitFreshInput;
  let inputAdmissionAttempted = false;
  let replyAdmissionTicket: ReturnType<typeof reserveReplyAdmissionTicket>;
  let releaseBeforeDispatch: void | (() => void) = undefined;
  let dashboardAuthority: Awaited<ReturnType<typeof createChatSendDashboardAuthority>> | undefined;
  try {
    const assertCustodyLifetimeCurrent = () => {
      admission.assertWorkAdmissionCurrent();
      if (sessionRoutingChanged(context.getRuntimeConfig())) {
        throw new Error("Session routing changed before input admission; refresh and retry.");
      }
    };
    const assertInputAdmissionCurrent = composeSessionSourceAssertion(
      [sessionMutationCommitGuard],
      (assertSource) => {
        admission.assertClientUploadAllowed?.();
        assertCustodyLifetimeCurrent();
        if (commitFreshInput) {
          sessionMutationAuthorization?.assertCurrent();
        }
        assertSource();
      },
    );
    assertInputAdmissionCurrent();
    const goalCommitGuard = request.goalOperation
      ? createChatSendGoalCommitGuard({
          admission,
          session,
          client,
          context,
          sessionMutationAuthorization,
          sessionMutationCommitGuard,
        })
      : undefined;
    const userTurn = createGatewayChatUserTurnController({
      ...setup,
      client,
      transcript: options?.transcript,
      isDirectExternalUser,
      startedAt: admissionStartedAt,
      warn: (message) => context.logGateway.warn(message),
      mentionInbox: context.mentionInbox,
      assertOriginalInputCommit: composeSessionSourceAssertion([
        assertInputAdmissionCurrent,
        // Ordinary chat can bind a session created after request authorization.
        commitInitialInput ? sessionMutationAuthorization?.assertCurrent : undefined,
      ]),
      goalCommitGuard,
    });
    const {
      persist: persistUserTurnTranscript,
      recorder: userTurnRecorder,
      replyContextFieldsPromise,
    } = userTurn;
    let needsSessionCreationBinding = !entry;
    const withUserTurnInputPublication = <T>(run: () => Promise<T>) =>
      admission.withInputCommitPublication(
        run,
        entry
          ? undefined
          : (source, committedEntry) => {
              sessionMutationAuthorization?.recordCreatedSession?.({
                agentId: session.agentId,
                sessionKey,
                storePath,
                sessionId: admittedSessionId,
                lifecycleRevision: committedEntry.lifecycleRevision,
                readSource: source,
                entry: committedEntry,
              });
              needsSessionCreationBinding = false;
            },
      );
    const persistGatewayUserTurnTranscript = (
      ...args: Parameters<typeof persistUserTurnTranscript>
    ) => withUserTurnInputPublication(() => persistUserTurnTranscript(...args));
    const persistGatewayUserTurnTranscriptBestEffort = (
      ...args: Parameters<typeof userTurn.persistBestEffort>
    ) => withUserTurnInputPublication(() => userTurn.persistBestEffort(...args));
    bindPreparedMediaRecorder(userTurnRecorder);
    phase?.mark("preparation");
    const preparedUserTurn = prepareChatSendUserTurn({
      ...setup,
      attachments: preparedAttachments.value,
      client,
      logGateway: context.logGateway,
      getConfig: context.getRuntimeConfig,
      userTurn,
    });
    const { ctx, isInternalTextSlashCommandTurn } = preparedUserTurn;
    admission.setPendingInputCleanup(async () => {
      try {
        const pending =
          userTurnRecorder.getPendingInputMessage?.() &&
          !userTurnRecorder.isPendingInputConsumed?.();
        const disposition =
          activeRunAbort.controller.signal.aborted &&
          activeRunAbort.entry?.abortStopReason !== "restart" &&
          !isAgentRunRestartAbortReason(activeRunAbort.controller.signal.reason)
            ? "cancelled"
            : "interrupted";
        userTurnRecorder.finishPendingInput?.(disposition);
        if (pending && activeRunAbort.controller.signal.aborted) {
          const reason = resolveChatAbortDiagnosticReason(
            activeRunAbort.controller.signal,
            activeRunAbort.entry,
          );
          context.logGateway.info(`chat pending input aborted: ${reason} (${disposition})`, {
            runId: clientRunId,
            sessionKey,
            sessionId: admittedSessionId,
            agentId: selectedAgent.agentId,
            disposition,
            reason,
          });
        }
        await userTurnRecorder.waitForPendingInputSettlement?.();
      } finally {
        dashboardAuthority?.release();
        releaseSessionAuthorization?.();
        void preparedUserTurn
          .discardUnreferencedMedia(userTurnRecorder.getPendingInputMessage?.())
          .catch((error: unknown) =>
            context.logGateway.warn(`Failed to discard unused chat media: ${String(error)}`),
          );
      }
    });
    phase?.mark("persist");
    let approvedInput: PersistedUserTurnMessage | undefined;
    let stageInput = Boolean(
      entry?.sessionId &&
      userTurn.baseInput.display !== false &&
      (!systemInputProvenance || systemInputProvenance.kind === "external_user") &&
      !isInternalTextSlashCommandTurn &&
      !request.goalOperation &&
      !restartSafeAdmission?.retryExpectedState &&
      !commitInitialInput,
    );
    if (stageInput && restartSafeAdmission) {
      inputAdmissionAttempted = true;
      const input = await admission.acquireInputActor();
      if (input) {
        const authority = {
          assertCurrent: assertCustodyLifetimeCurrent,
          authorize: assertCustodyLifetimeCurrent,
        };
        const state = input.actor.snapshot(authority) ?? (await input.actor.read(authority));
        // Older Gateways can leave custody behind before committing the recovery
        // claim. Recover that input; fresh idle sends commit transcript custody directly.
        stageInput = state.pendingInputs.some(
          (pending) => pending.idempotency_key === userTurn.baseInput.idempotencyKey,
        );
      }
    }
    if (stageInput) {
      // ACK transfers input custody. Persist approved source bytes before
      // dispatch; a validated durable retry already owns its transcript input.
      inputAdmissionAttempted = true;
      using stagePhase = diagnostics.scope("detail.persist.stage");
      const staged = await userTurnRecorder.stageApproved?.(
        createChatSendPendingInputAdmission({
          runId: clientRunId,
          expectedProfileId: req.expectedProfileId,
          sessionMutationAuthorization,
          sessionMutationCommitGuard,
          assertCustodyLifetimeCurrent,
          assertClientUploadAllowed: admission.assertClientUploadAllowed,
        }),
      );
      stagePhase?.finish();
      if (userTurnRecorder.isPendingInputConsumed?.()) {
        admission.cleanupAdmittedRun();
        clearAgentRunContext(clientRunId, lifecycleGeneration);
        respond(true, { runId: clientRunId, status: "ok" }, undefined, {
          cached: true,
          runId: clientRunId,
        });
        return;
      }
      if (!staged) {
        throw new Error("Chat input was not durably admitted; refresh and retry.");
      }
      approvedInput = userTurnRecorder.getPendingInputMessage?.();
      emitSessionsChanged(
        context,
        { sessionKey, agentId: selectedAgent.agentId, reason: "send" },
        { accessChanged: false },
      );
    }
    let goalResult: SessionGoalOperationResult | undefined;
    if (restartSafeAdmission) {
      inputAdmissionAttempted = true;
      using transcriptPhase = diagnostics.scope("detail.persist.transcript");
      const persistedUserTurn = await persistGatewayUserTurnTranscript();
      transcriptPhase?.finish();
      if (commitInitialInput || (!request.goalOperation && commitFreshInput)) {
        approvedInput = persistedUserTurn?.message;
      }
      const goalOperation = request.goalOperation;
      if (goalOperation) {
        const mutation = persistedUserTurn?.sessionTurnMutationResult;
        goalResult = mutation?.result;
        if (!goalResult) {
          goalResult = await lookupSessionGoalOperation({
            sessionKey,
            storePath,
            agentId: session.agentId,
            expectedSessionId: admittedSessionId,
            operation: goalOperation,
          });
          assertInputAdmissionCurrent();
          goalCommitGuard?.assertCurrent();
        }
        if (goalResult && (!persistedUserTurn || mutation?.replayed)) {
          admission.cleanupAdmittedRun();
          clearAgentRunContext(clientRunId, lifecycleGeneration);
          respond(true, { ...goalResult, replayed: true }, undefined, {
            cached: true,
            runId: clientRunId,
          });
          return;
        }
        if (!goalResult || !persistedUserTurn?.sessionEntry) {
          throw new Error("Goal and its input were not durably admitted.");
        }
        if (admission.initialSessionEntry) {
          await recordSessionCreated(session.cfg, {
            sessionKey,
            agentId: session.agentId,
            entry: persistedUserTurn.sessionEntry,
          });
        }
        await publishCommittedSessionGoalChange(context, {
          sessionKey,
          agentId: session.agentId,
          entry: persistedUserTurn.sessionEntry,
          actor: gatewayClientSessionCreator(client),
          summary: `goal ${goalOperation.action}`,
        });
      }
      // A matching idempotency row and lifecycle claim commit atomically, so
      // retries adopt the durable turn without submitting it twice.
      if (
        !persistedUserTurn ||
        persistedUserTurn.sessionEntry?.restartRecoveryDeliveryRunId !== clientRunId ||
        persistedUserTurn.sessionEntry.restartRecoveryDeliverySourceRunId !== clientRunId
      ) {
        throw new Error("chat turn was not durably admitted");
      }
      if (lifecycleGeneration !== getAgentEventLifecycleGeneration()) {
        if (activeRunAbort.entry) {
          activeRunAbort.entry.abortStopReason = "restart";
        }
        activeRunAbort.controller.abort(createAgentRunRestartAbortError());
      }
      if (activeRunAbort.controller.signal.aborted) {
        // No runtime adopted this durable input; retain its same-ID restart retry.
        if (
          !(await terminalizeRestartSafeAdmission({
            retryable: activeRunAbort.entry?.abortStopReason === "restart",
            status: "killed",
          }))
        ) {
          throw new Error("chat admission ownership changed before terminalization");
        }
        finishAbortedChatSend();
        return;
      }
      if (sessionRoutingChanged(context.getRuntimeConfig())) {
        if (!(await terminalizeRestartSafeAdmission({ retryable: true, status: "failed" }))) {
          throw new Error("chat admission ownership changed before terminalization");
        }
        admission.rejectSessionRoutingChanged();
        return;
      }
    }
    if (approvedInput) {
      preparedUserTurn.applyApprovedText(
        extractTextFromChatContent(approvedInput.content, {
          joinWith: "\n",
          normalizeText: (value) => value,
        }) ?? "",
      );
    }

    using dashboardPhase = diagnostics.scope("detail.persist.authority");
    dashboardAuthority = await createChatSendDashboardAuthority({
      admission,
      session,
      client,
      context,
      hasCurrentClientAuthority,
      sessionMutationCommitGuard,
      sessionMutationAuthorization,
      externalAuthorityAdmission,
      externalAdmissionParams,
    });
    dashboardPhase?.finish();
    const assertDashboardReadCurrent = dashboardAuthority.assertReadCurrent;
    dashboardAuthority.bindPromptRecorder(userTurnRecorder);
    phase?.mark("preparation");
    if (messageInjectionTarget) {
      invalidateSkillAuthoringForOtherRequester(
        sessionKey,
        client?.internal?.syntheticClient ? undefined : client?.authenticatedUserProfile?.profileId,
      );
    }
    // Rendering can fail independently of admission; preserve the raw steer on failure.
    const steerDocumentContext =
      messageInjectionTarget && !isInternalTextSlashCommandTurn && ctx.media?.length
        ? await mediaDocumentContextLoader
            .load()
            .then(async (runtime) => ({
              status: "rendered" as const,
              ...(await runtime.renderInboundDocumentContext({
                ctx,
                cfg: session.cfg,
              })),
            }))
            .catch((err: unknown) => {
              // A poisoned lazy import must not be served to later steers.
              mediaDocumentContextLoader.clear();
              logVerbose(
                `steer document render failed, injecting raw content: ${formatErrorMessage(err)}`,
              );
              return { status: "failed" as const };
            })
        : undefined;
    if (settleInterruptedPreparation()) {
      return;
    }
    const beginCapturedMessageInjection = createChatSendMessageInjectionStarter({
      operatorAuthority: admission.operatorAuthority,
      target: messageInjectionTarget,
      abortSignal: activeRunAbort.controller.signal,
      request,
      session,
      admittedSessionSettings: admission.admittedSessionSettings,
      turn: preparedUserTurn,
      imageOrder,
      documentContext: steerDocumentContext,
      userTurnTranscriptRecorder: userTurnRecorder,
      logGateway: context.logGateway,
      assertCurrent:
        req.expectedProfileId === undefined &&
        !admission.assertClientUploadAllowed &&
        !isProgressCardRefreshInputProvenance(systemInputProvenance)
          ? undefined
          : assertInputAdmissionCurrent,
    });
    const preAckReplyContextPromise =
      messageInjectionTarget && !isInternalTextSlashCommandTurn
        ? replyContextFieldsPromise
        : undefined;
    phase?.mark("replyContext");
    if (preAckReplyContextPromise) {
      applyChatSendReplyContextFields(ctx, await preAckReplyContextPromise);
      if (settleInterruptedPreparation()) {
        return;
      }
    }
    assertInputAdmissionCurrent();
    let messageInjectionAttempt =
      !p.replyToId || preAckReplyContextPromise ? await beginCapturedMessageInjection() : undefined;
    phase?.mark("runAdmission");
    const preAckInjection = await settleChatSendPreAckMessageInjection({
      attempt: messageInjectionAttempt,
      isAborted: () => activeRunAbort.controller.signal.aborted,
      sessionRoutingChanged: () => sessionRoutingChanged(context.getRuntimeConfig()),
      onAborted: finishAbortedChatSend,
      onSessionRoutingChanged: admission.rejectSessionRoutingChanged,
    });
    if (preAckInjection.status === "handled") {
      return;
    }
    messageInjectionAttempt = preAckInjection.attempt;
    phase?.mark("effects");
    const { serverTiming, chatSendTiming, ackReadyEvent } = prepareChatSendAckTiming({
      client,
      request,
      session,
      prepareAttachmentsMs,
      chatSendTraceAttributes,
    });
    if (options?.beforeDispatch) {
      assertInputAdmissionCurrent();
      releaseBeforeDispatch = await options.beforeDispatch({
        runId: clientRunId,
        assertCurrent: assertInputAdmissionCurrent,
        assertWorkAdmissionCurrent: () => {
          admission.assertClientUploadAllowed?.();
          admission.assertWorkAdmissionCurrent();
        },
      });
      assertInputAdmissionCurrent();
    }
    context.addChatRun(clientRunId, {
      sessionKey,
      agentId: selectedAgent.agentId,
      clientRunId,
      ...(chatSendTiming ? { chatSendTiming } : {}),
    });
    // Only the recorder can attest transcript placement; custody and a started ACK cannot.
    const receipt = userTurnRecorder.getAdmissionReceipt?.();
    const ackPayload = {
      ...goalResult,
      runId: clientRunId,
      status: "started" as const,
      ...(receipt ? { messageSeq: receipt.activeMessagePosition + 1 } : {}),
      ...(interruptedActiveRun ? { interruptedActiveRun: true } : {}),
      ...(serverTiming ? { serverTiming } : {}),
    };
    emitDiagnosticsTimelineEvent(ackReadyEvent(ackPayload.status), { config: cfg });
    // After the ACK, dispatch owns the turn: its error lifecycle persists the
    // user transcript (which references the media) on every path, so a
    // post-ACK cleanupAdmittedRun must not race that persist with a discard.
    assertInputAdmissionCurrent();
    admission.setDiscardAbandonedPreparedMedia(undefined);
    replyAdmissionTicket = reserveReplyAdmissionTicket([
      ctx.SessionKey,
      ctx.CommandTargetSessionKey,
    ]);
    phase?.mark("response");
    respond(true, ackPayload, undefined, { runId: clientRunId });
    phase?.finish();
    diagnostics.acknowledge(messageInjectionAttempt ? "steer" : "startup");
    context.recordClientActivity?.(client);
    const chatSendAckedAtMs = chatSendTiming?.ackedAtMs ?? performance.now();
    // Dispatch owns execution from this point, including deferred and collected turns.
    releaseBeforeDispatch = undefined;
    startChatDispatch({
      ...setup,
      replyAdmissionTicket,
      diagnostics,
      admissionStartedAt,
      attachments: preparedAttachments.value,
      client,
      context,
      toolsAllow: options?.toolsAllow,
      prepareAssistantTranscriptMessage: options?.prepareAssistantTranscriptMessage,
      skillLibrary: {
        sessionKey,
        owner: {
          client,
          context,
          sessionMutationCommitGuard: () => {
            sessionMutationCommitGuard?.();
            admission.assertWorkAdmissionCurrent();
          },
        },
        isHumanTurn:
          !options &&
          !systemInputProvenance &&
          !reconnectResumeRequested &&
          request.turnKind === "main",
      },
      cronCreatorAuthority,
      assertDashboardReadCurrent,
      getSessionInitializationOptions: createChatSendSessionInitialization({
        sessionKey,
        agentId: session.agentId,
        authorization: sessionMutationAuthorization,
        needsCreationBinding: needsSessionCreationBinding,
        getSessionInitializationOptions: userTurn.getSessionInitializationOptions,
      }),
      externalAuthorityAdmission,
      injection: {
        beginCapturedMessageInjection,
        messageInjectionAttempt,
        preAckReplyContextPromise,
        replyContextFieldsPromise,
      },
      terminalizeRestartSafeAdmission,
      timing: {
        chatSendAckedAtMs,
        chatSendTiming,
      },
      turn: preparedUserTurn,
      userTurn: {
        ...userTurn,
        persist: persistGatewayUserTurnTranscript,
        persistBestEffort: persistGatewayUserTurnTranscriptBestEffort,
      },
    });
    admittedCleanup.dispatched = true;
  } catch (err) {
    dashboardAuthority?.release();
    releaseBeforeDispatch?.();
    replyAdmissionTicket?.release();
    await handleChatSendSetupError({
      // Uncommitted Goal admissions may retry with their original identity. Committed
      // outcomes replay from the durable receipt instead of this transient error cache.
      cacheResult: request.goalOperation === undefined && !inputAdmissionAttempted,
      admission,
      context,
      error: err,
      respond,
      session,
      terminalizeRestartSafeAdmission,
    });
  }
}

export async function handleChatSend(
  options: GatewayRequestHandlerOptions,
  onAdmissionOwned?: () => Promise<boolean>,
  externalAuthorityAdmission?: ChatSendExternalAuthorityAdmission,
): Promise<void> {
  await handleChatSendWithOptions(options, onAdmissionOwned, externalAuthorityAdmission);
}

/** The ordinary chat owner retains the exact human-reviewed continuation through settlement. */
export async function handleProviderReviewContinuationChat(
  options: GatewayRequestHandlerOptions,
  acknowledgment: ProviderReviewAcknowledgment,
): Promise<void> {
  let admissionOwned = false;
  try {
    await handleChatSendWithOptions(
      options,
      async () => {
        admissionOwned = true;
        return true;
      },
      undefined,
      { providerReviewAcknowledgment: acknowledgment },
    );
  } finally {
    if (!admissionOwned) {
      retireProviderReviewAcknowledgment(acknowledgment);
    }
  }
}

/** Operator Resume admits one hidden internal continuation with the Goal transition. */
export async function handleSessionGoalResumeChat(
  options: GatewayRequestHandlerOptions,
  operation: SessionGoalOperation & { action: "resume" },
): Promise<void> {
  await handleChatSendWithOptions(options, undefined, undefined, { goalResume: operation });
}

/** Dispatches Gateway-authored system input without widening the public chat-send contract. */
export async function handleTrustedInternalChatSend(
  options: GatewayRequestHandlerOptions,
  onAdmissionOwned?: () => Promise<boolean>,
  inputOptions?: Pick<
    ChatSendInternalOptions,
    "transcript" | "toolsAllow" | "prepareAssistantTranscriptMessage" | "beforeDispatch"
  >,
): Promise<void> {
  await handleChatSendWithOptions(options, onAdmissionOwned, undefined, {
    ...inputOptions,
    trustedSystemInput: true,
  });
}
