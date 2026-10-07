// Detached chat.send dispatch owns runtime delivery, post-dispatch persistence, and terminalization.
import { performance } from "node:perf_hooks";
import {
  GATEWAY_CLIENT_CAPS,
  hasGatewayClientCap,
} from "../../../packages/gateway-protocol/src/client-info.js";
import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import { classifyAgentRunTerminalOutcome } from "../../agents/agent-run-terminal-outcome.js";
import { resolveProviderIdForAuth } from "../../agents/provider-auth-aliases.js";
import { dispatchInboundMessageWithProjectedDispatcher } from "../../auto-reply/dispatch.js";
import type { ReplyDispatchRun } from "../../auto-reply/get-reply-options.types.js";
import { isReplyPayloadStatusNotice } from "../../auto-reply/reply-payload.js";
import { REPLY_ADMISSION_TICKET } from "../../auto-reply/reply/reply-admission-ticket.js";
import { isInternalSourceReplyChannel } from "../../auto-reply/reply/source-reply-delivery-mode.js";
import { readAgentRunTerminalOutcome } from "../../channels/turn/agent-run-terminal-outcome.js";
import { onAgentEventForRun } from "../../infra/agent-events.js";
import { measureDiagnosticsTimelineSpan } from "../../infra/diagnostics-timeline.js";
import { isProgressCardRefreshInputProvenance } from "../../sessions/input-provenance.js";
import { withCurrentUserTurnInput } from "../../sessions/user-turn-transcript-runtime-context.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { isOperatorUiClient } from "../../utils/message-channel.js";
import { captureAgentJobSession, setGatewayDedupeEntry } from "../agent-turn/agent-job.js";
import { updateChatRunProvider } from "../chat-abort.js";
import { discardPreparedInboundMedia } from "../chat-attachments.js";
import { chatRunBelongsToSelectedAgent } from "../chat-run-owner.js";
import { tryResolveSessionCompatibilityOwnerAgentId } from "../session-request-agent.js";
import { buildAbortedChatSendPayload } from "./chat-abort-authorization.js";
import { broadcastChatDelta, broadcastChatError } from "./chat-broadcast.js";
import type { StartChatDispatchParams } from "./chat-send-agent-dispatch.types.js";
import {
  resolveWebchatPromptCacheKey,
  scheduleChatDashboardSessionTitle,
} from "./chat-send-background.js";
import { readChatSendReplyPayload } from "./chat-send-command-replies.js";
import {
  createChatSendDispatchErrorLifecycle,
  formatReturnedAgentErrors,
} from "./chat-send-dispatch-errors.js";
import {
  finalizeAcceptedChatSendMessageInjection,
  settleChatSendMessageInjection,
} from "./chat-send-message-injection.js";
import { applyChatSendReplyContextFields } from "./chat-send-reply-context.js";
import { createChatSendReplyDispatch } from "./chat-send-reply-dispatch.js";
import { finalizeChatSendDispatchedReplies } from "./chat-send-reply-finalization.js";
import {
  classifyAcceptedChatSendFailure,
  runAcceptedChatSendDispatch,
  waitForAcceptedChatSendRetry,
} from "./chat-send-retry.js";
import { finalizeChatSendSourceReplies } from "./chat-send-source-finalization.js";
import { createChatSendTurnAdoptionLifecycle } from "./chat-send-turn-adoption.js";
import { applyChatSendManagedMedia } from "./chat-send-user-turn.js";
import {
  createOperatorChatSendServerTiming,
  roundedChatSendTimingMs,
} from "./chat-server-timing.js";
import { emitSessionsChanged } from "./session-change-event.js";
import { prepareSessionWorkspace } from "./session-create-project.js";

export function startChatDispatch(params: StartChatDispatchParams): void {
  const {
    replyAdmissionTicket,
    diagnostics,
    admissionStartedAt,
    admission,
    attachments,
    client,
    context,
    toolsAllow,
    skillWorkshopProposalRevision,
    prepareSkillLibraryAuthoring,
    cronCreatorAuthority,
    assertDashboardReadCurrent,
    externalAuthorityAdmission,
    injection,
    request,
    session,
    terminalizeRestartSafeAdmission,
    turn,
    userTurn,
  } = params;
  const { imageOrder } = attachments;
  const progressRefresh = isProgressCardRefreshInputProvenance(request.systemInputProvenance);
  const {
    activeRunAbort,
    admittedSessionId,
    chatSendTraceAttributes,
    gatewayWorkAdmission,
    messageInjectionTarget,
    retainGatewayWorkAdmission,
    restartSafeAdmission,
    sessionBinding,
  } = admission;
  const {
    activeRunScopeKey,
    agentId,
    cfg,
    clientRunId,
    entry,
    expectedLeafEntryId,
    requestedSessionId,
    resolvedSessionModel,
    storePath,
    selectedAgent,
    sessionKey,
  } = session;
  const { clientInfo, p, reconnectResumeRequested, supportsTaskSuggestions } = request;
  const {
    accountId,
    ctx,
    isInternalTextSlashCommandTurn,
    managedMediaApplyMode,
    pluginBoundMediaPromise,
    queuedFollowupOwnerKey,
    replyOptionImages,
    replyOptionMedia,
  } = turn;
  const {
    persist: persistGatewayUserTurnTranscript,
    persistBestEffort: persistGatewayUserTurnTranscriptBestEffort,
    recorder: userTurnRecorder,
  } = userTurn;
  const { beginCapturedMessageInjection, preAckReplyContextPromise, replyContextFieldsPromise } =
    injection;
  let { messageInjectionAttempt } = injection;

  // The first release wins: true when reply progress frees naming while the turn still runs.
  const titleReady = createDeferredCore<boolean>();
  const turnSettled = createDeferredCore();
  let titleWaiting = true;
  let stopTitleWait: (() => void) | undefined;
  const releaseTitle = (duringTurn: boolean) => {
    stopTitleWait?.();
    stopTitleWait = undefined;
    titleWaiting = false;
    titleReady.resolve(duringTurn);
  };

  const jobSessionBinding = admission.sessionBinding;
  let agentRunStarted = false;
  let replyDispatchRun: ReplyDispatchRun | undefined;
  const isRunCurrent = () =>
    !activeRunAbort.controller.signal.aborted &&
    context.chatAbortControllers.get(clientRunId) === activeRunAbort.entry;
  const replyDispatch = createChatSendReplyDispatch({
    requesterContext: ctx,
    accountId,
    prepareAssistantTranscriptMessage: params.prepareAssistantTranscriptMessage,
    isAgentRunStarted: () => agentRunStarted,
    isRunCurrent: () =>
      isRunCurrent() ||
      (!activeRunAbort.controller.signal.aborted &&
        context.chatQueuedTurns.get(clientRunId)?.controller === activeRunAbort.controller),
    abortSignal: activeRunAbort.controller.signal,
    onCommandBlock: isInternalTextSlashCommandTurn
      ? (text) =>
          broadcastChatDelta({
            context,
            runId: clientRunId,
            sessionKey,
            agentId,
            text,
            isCurrent: isRunCurrent,
          })
      : undefined,
    getReplyDispatchRun: () => replyDispatchRun,
    logGateway: context.logGateway,
    session,
    userTurnRecorder,
  });
  const queuedFollowup = createChatSendTurnAdoptionLifecycle({
    requesterContext: ctx,
    accountId,
    chatQueuedTurns: context.chatQueuedTurns,
    context,
    runId: clientRunId,
    controller: activeRunAbort.controller,
    sessionBinding: admission.sessionBinding,
    sessionKey,
    agentId: selectedAgent.agentId,
    ownerConnId: client?.connId,
    ownerDeviceId: client?.connect?.device?.id,
    ownerKey: queuedFollowupOwnerKey,
    ...(expectedLeafEntryId !== undefined ? { originatingLeafEntryId: expectedLeafEntryId } : {}),
    originatingChannel: admission.originatingRoute.originatingChannel,
    session,
    hasCronCreatorAuthority: cronCreatorAuthority !== undefined,
    suppressReplies: progressRefresh,
    releaseSourceWorkAdmission: admission.releaseSourceWorkAdmission,
    retainWorkAdmission: retainGatewayWorkAdmission,
    armOperatorRunCancellation: admission.armOperatorRunCancellation,
    retireOperatorRunCancellation: admission.retireOperatorRunCancellation,
  });
  let acceptedMessageInjection = false;
  const classifyDispatchFailure = (error: unknown) =>
    classifyAcceptedChatSendFailure({
      error,
      phase: "post-ack",
      executionStarted: agentRunStarted,
      sideEffectsObserved:
        acceptedMessageInjection ||
        messageInjectionAttempt !== undefined ||
        replyDispatch.deliveredReplies.length > 0,
    });
  const dispatchErrorLifecycle = createChatSendDispatchErrorLifecycle({
    admission,
    classifyFailure: classifyDispatchFailure,
    context,
    isAgentRunStarted: () => agentRunStarted,
    isQueuedFollowupEnqueued: () => queuedFollowup.isEnqueued() || queuedFollowup.isTerminal(),
    persistUserTurnTranscript: persistGatewayUserTurnTranscript,
    session,
    terminalizeRestartSafeAdmission,
    userTurnRecorder,
    isReplyDispatchRun: () => replyDispatchRun !== undefined,
  });
  const {
    emit: emitServerTiming,
    emitFirstAssistant: emitFirstAssistantServerTiming,
    dispatchStartedAtMs,
  } = createOperatorChatSendServerTiming(params);
  emitServerTiming("dispatch-started");
  const dispatchAdmission = {
    run: <T>(operation: () => Promise<T>) =>
      gatewayWorkAdmission.run(async () => {
        acceptedMessageInjection = await settleChatSendMessageInjection(messageInjectionAttempt);
        return await (acceptedMessageInjection
          ? operation()
          : withCurrentUserTurnInput(userTurnRecorder, operation));
      }),
  };
  const dashboardReadAdmission = assertDashboardReadCurrent
    ? {
        agentId,
        runId: clientRunId,
        sessionKey,
        // Fresh-session initialization updates this original registration's SID.
        get sessionId() {
          return sessionBinding.sessionId;
        },
        assertCurrent: assertDashboardReadCurrent,
      }
    : undefined;
  const phase = diagnostics.scope("dispatch");
  const dispatch = replyDispatch
    .runAgentMediaTranscript(dispatchAdmission, () =>
      measureDiagnosticsTimelineSpan(
        "gateway.chat_send.dispatch_inbound",
        async () => {
          // Input already owned by the sink must finalize before source admission can fail.
          if (!acceptedMessageInjection) {
            admission.assertWorkAdmissionCurrent();
          }
          let assertWorkspaceRunOwnership: (() => void) | undefined;
          if (
            !acceptedMessageInjection &&
            entry &&
            (Object.hasOwn(entry, "pendingProjectGitUrl") || entry.pendingWorktree)
          ) {
            phase?.mark("worktree");
            assertWorkspaceRunOwnership = await prepareSessionWorkspace({
              admission,
              client,
              context,
              session,
            });
            assertWorkspaceRunOwnership();
          }
          phase?.mark("replyContext");
          if (replyContextFieldsPromise && !preAckReplyContextPromise) {
            const replyContextFields = await replyContextFieldsPromise;
            assertWorkspaceRunOwnership?.();
            applyChatSendReplyContextFields(ctx, replyContextFields);
            messageInjectionAttempt = await withCurrentUserTurnInput(
              userTurnRecorder,
              beginCapturedMessageInjection,
            );
          }
          if (messageInjectionAttempt) {
            const injected = await finalizeAcceptedChatSendMessageInjection({
              attempt: messageInjectionAttempt,
              sessionBinding: jobSessionBinding,
              context,
              ctx,
              persistUserTurnTranscriptBestEffort: async () => {
                await persistGatewayUserTurnTranscriptBestEffort();
              },
              session,
              startedAt: admissionStartedAt,
              target: messageInjectionTarget!,
            });
            assertWorkspaceRunOwnership?.();
            if (injected) {
              acceptedMessageInjection = true;
              return {
                queuedFinal: false,
                counts: { tool: 0, block: 0, final: 0 },
              };
            }
          }
          phase?.mark("preparation");
          await turn.prepareSessionCreation();
          phase?.mark("authoring");
          const skillLibraryAuthoring = await prepareSkillLibraryAuthoring();
          admission.assertWorkAdmissionCurrent();
          phase?.mark("preparation");
          const pluginBoundMedia = await pluginBoundMediaPromise;
          assertWorkspaceRunOwnership?.();
          applyChatSendManagedMedia(ctx, pluginBoundMedia, managedMediaApplyMode);
          phase?.mark("replyInitialization");
          const dispatchInbound = () => {
            assertWorkspaceRunOwnership?.();
            return dispatchInboundMessageWithProjectedDispatcher({
              ctx,
              cfg,
              toolsAllow,
              dispatcherOptions: replyDispatch.dispatcherOptions,
              onSessionMetadataChanges: (changes) =>
                changes.forEach((change) => emitSessionsChanged(context, change)),
              replyOptions: {
                [REPLY_ADMISSION_TICKET]: replyAdmissionTicket,
                prepareAssistantTranscriptMessage: replyDispatch.prepareAssistantTranscriptMessage,
                ...(isInternalSourceReplyChannel(ctx)
                  ? { resolveReplyDelivery: replyDispatch.resolveReplyDelivery }
                  : {}),
                ...(admission.admittedSessionSettings
                  ? { admittedSessionSettings: admission.admittedSessionSettings }
                  : {}),
                runId: clientRunId,
                operatorAuthority: admission.operatorAuthority,
                providerReviewAcknowledgment: request.providerReviewAcknowledgment,
                dashboardReadAdmission,
                skillWorkshopProposalRevision,
                skillLibraryAuthoring,
                ...(cronCreatorAuthority
                  ? { cronCreatorAuthorityCapability: cronCreatorAuthority }
                  : {}),
                ...(isOperatorUiClient(clientInfo)
                  ? {
                      promptCacheKey: resolveWebchatPromptCacheKey({
                        agentId,
                        provider: resolvedSessionModel.provider,
                        model: resolvedSessionModel.model,
                        sessionKey: activeRunScopeKey,
                      }),
                    }
                  : {}),
                ...(supportsTaskSuggestions
                  ? { taskSuggestionDeliveryMode: "gateway" as const }
                  : {}),
                requestedSessionId,
                expectedActiveReplyOperation: admission.expectedActiveReplyOperation,
                ...(restartSafeAdmission
                  ? {
                      expectedExistingSessionId: admittedSessionId,
                      pinExpectedExistingSession: true,
                      newlyCreatedSessionId: admission.initialSessionEntry?.sessionId,
                    }
                  : entry?.sessionId
                    ? { expectedExistingSessionId: entry.sessionId }
                    : {}),
                resumeRequestedSession: reconnectResumeRequested,
                onSessionPrepared: (binding) => {
                  phase?.mark("preparation");
                  admission.onSessionPrepared(binding);
                  replyDispatch.notePreparedSession(binding);
                },
                onTranscriptStartPreparation: () => diagnostics.scope("snapshot")?.finish,
                abortSignal: activeRunAbort.controller.signal,
                getProviderLoginConfig: context.getRuntimeConfig,
                assertProviderLoginAuthority: () => {
                  client?.connectionSignal?.throwIfAborted();
                  if (client?.invalidated || !client?.connect.scopes?.includes("operator.admin")) {
                    throw new Error("Provider login authority is no longer active.");
                  }
                },
                // Retain this input identity while followup/collect owns its execution.
                onFollowupQueueDisposition: queuedFollowup.onQueueDisposition,
                onQueuedFollowupReplyBatch: queuedFollowup.onQueuedFollowupReplyBatch,
                turnAdoptionLifecycle: queuedFollowup.lifecycle,
                images: replyOptionImages,
                imageOrder: imageOrder.length > 0 ? imageOrder : undefined,
                media: replyOptionMedia,
                ...(p.timeoutMs !== undefined ? { timeoutOverrideMs: p.timeoutMs } : {}),
                thinkingLevelOverride: p.thinking,
                fastModeOverride: p.fastMode,
                queueModeOverride: p.queueMode,
                userTurnTranscriptRecorder: userTurnRecorder,
                ...(p.queueMode === "steer" && messageInjectionTarget
                  ? { messageInjectionDisposition: "rejected" as const }
                  : {}),
                ...(restartSafeAdmission ? { suppressNextUserMessagePersistence: true } : {}),
                fastModeAutoOnSecondsOverride: p.fastAutoOnSeconds,
                onAgentRunStart: (runId, _identity, options, transcriptStart) => {
                  queuedFollowup.onRunStarted(runId);
                  diagnostics.finish();
                  if (titleWaiting) {
                    stopTitleWait?.();
                    stopTitleWait = onAgentEventForRun(runId, (event) => {
                      if (
                        event.stream === "assistant" ||
                        event.stream === "item" ||
                        event.stream === "tool" ||
                        event.stream === "thinking" ||
                        event.stream === "approval"
                      ) {
                        releaseTitle(true);
                      }
                    });
                  }
                  replyDispatchRun = options;
                  if (activeRunAbort.markExecutionStarted()) {
                    admission.armOperatorRunCancellation();
                    emitSessionsChanged(
                      context,
                      { sessionKey, agentId, reason: "agent.run.started" },
                      { accessChanged: false },
                    );
                  }
                  // A bound runtime can start on a different transcript than the source chat.
                  agentRunStarted = true;
                  replyDispatch.captureAgentTranscriptStart(runId, transcriptStart);
                  emitServerTiming(
                    "agent-run-started",
                    runId !== clientRunId ? { agentRunId: runId } : undefined,
                    dispatchStartedAtMs,
                  );
                  const connId = typeof client?.connId === "string" ? client.connId : undefined;
                  const wantsToolEvents = hasGatewayClientCap(
                    client?.connect?.caps,
                    GATEWAY_CLIENT_CAPS.TOOL_EVENTS,
                  );
                  if (connId && wantsToolEvents) {
                    context.registerToolEventRecipient(runId, connId);
                    // Register for any other active runs *in the same session* so
                    // late-joining clients (e.g. page refresh mid-response) receive
                    // in-progress tool events without leaking cross-session data.
                    const compatibilityOwnerAgentId = tryResolveSessionCompatibilityOwnerAgentId(
                      cfg,
                      sessionKey,
                    );
                    const selectedSessionAgentId = selectedAgent.agentId;
                    for (const [activeRunId, active] of context.chatAbortControllers) {
                      const sameSelectedAgent =
                        selectedSessionAgentId !== undefined &&
                        chatRunBelongsToSelectedAgent({
                          agentId: active.agentId,
                          sessionKey: active.sessionKey,
                          defaultAgentId: compatibilityOwnerAgentId,
                          selectedAgentId: selectedSessionAgentId,
                        });
                      const sameSession = active.sessionKey === sessionKey && sameSelectedAgent;
                      if (activeRunId !== runId && sameSession) {
                        context.registerToolEventRecipient(activeRunId, connId);
                      }
                    }
                  }
                  return options?.completionSource;
                },
                onModelSelected: (modelSelection) => {
                  updateChatRunProvider(context.chatAbortControllers, {
                    runId: clientRunId,
                    providerId: modelSelection.provider,
                    authProviderId: resolveProviderIdForAuth(modelSelection.provider, {
                      config: cfg,
                    }),
                  });
                  replyDispatch.onModelSelected(modelSelection);
                  emitServerTiming(
                    "model-selected",
                    {
                      provider: modelSelection.provider,
                      model: modelSelection.model,
                    },
                    dispatchStartedAtMs,
                  );
                },
              },
            });
          };
          const dispatchWithRetry = () =>
            runAcceptedChatSendDispatch({
              operation: () => withCurrentUserTurnInput(userTurnRecorder, dispatchInbound),
              classify: classifyDispatchFailure,
              waitForRetry: (error) =>
                waitForAcceptedChatSendRetry(
                  { agentId, sessionKey, storePath },
                  error,
                  activeRunAbort.controller.signal,
                ),
            });
          const dispatchResult = await (cronCreatorAuthority && externalAuthorityAdmission
            ? externalAuthorityAdmission.run(
                cronCreatorAuthority,
                dispatchWithRetry,
                activeRunAbort.controller.signal,
              )
            : dispatchWithRetry());
          if (dispatchResult.beforeAgentRunBlocked === true) {
            userTurnRecorder.markBlocked();
          }
          return dispatchResult;
        },
        {
          phase: "agent-turn",
          config: cfg,
          attributes: chatSendTraceAttributes,
        },
      ),
    )
    .then(async (dispatchResult) => {
      diagnostics.finish();
      if (acceptedMessageInjection || queuedFollowup.isEnqueued() || queuedFollowup.isTerminal()) {
        return;
      }
      emitServerTiming("dispatch-completed", undefined, dispatchStartedAtMs);
      const postDispatchStartedAtMs = performance.now();
      await measureDiagnosticsTimelineSpan(
        "gateway.chat_send.post_dispatch",
        async () => {
          const replyDispatchResult = replyDispatchRun?.getResult();
          const runtimeOutcome = replyDispatchResult?.terminalOutcome;
          const recordedOutcome = readAgentRunTerminalOutcome(dispatchResult);
          // ACP owns a rich terminal result; native runs record their outcome on dispatch.
          // Delivered warnings or source replies cannot replace either authoritative result.
          const runtimeClassification = runtimeOutcome
            ? classifyAgentRunTerminalOutcome(runtimeOutcome)
            : recordedOutcome && (recordedOutcome === "failed" ? "failure" : "success");
          const runtimeCancelled = runtimeClassification === "cancellation";
          const runtimeFailed =
            runtimeClassification === "failure" || runtimeClassification === "timeout";
          const returnedAgentErrorPayloads = replyDispatch.deliveredReplies
            .map((entryInner) => readChatSendReplyPayload(entryInner.input))
            .filter((payload) => payload.isError);
          // Native streams cannot publish a host-authored warning. Give a warning-only
          // turn the normal reply owner without reclassifying the runtime outcome.
          const hasOnlyFinalWarnings =
            returnedAgentErrorPayloads.length > 0 &&
            replyDispatch.deliveredReplies.every(({ kind, input }) => {
              const payload = readChatSendReplyPayload(input);
              return (
                (kind === "final" && payload.isError === true) ||
                isReplyPayloadStatusNotice(payload)
              );
            });
          const hasReturnedAgentError = runtimeClassification
            ? runtimeFailed
            : returnedAgentErrorPayloads.length > 0 &&
              (agentRunStarted || !isInternalTextSlashCommandTurn);
          const returnedAgentErrorMessage =
            runtimeOutcome?.error ??
            (formatReturnedAgentErrors(
              returnedAgentErrorPayloads
                .map((payload) => payload.text?.trim())
                .filter((text): text is string => Boolean(text)),
            ) ||
              (runtimeFailed ? "agent run failed" : undefined));
          if (
            !userTurnRecorder.hasPersisted() &&
            !userTurnRecorder.isBlocked() &&
            (hasReturnedAgentError ||
              (agentRunStarted &&
                returnedAgentErrorPayloads.length === 0 &&
                userTurnRecorder.hasRuntimePersistencePending()))
          ) {
            await persistGatewayUserTurnTranscriptBestEffort();
          }
          let finalizedSourceReply = false;
          // A dispatched runtime owns its persisted turn; this owner projects
          // only settled, post-hook replies. Native runtimes project their own stream.
          if (
            !progressRefresh &&
            (!agentRunStarted || replyDispatchRun || hasOnlyFinalWarnings) &&
            !hasReturnedAgentError &&
            !context.chatRunState.hasAbortMarker(clientRunId)
          ) {
            await finalizeChatSendDispatchedReplies({
              requesterContext: ctx,
              abortSignal: activeRunAbort.controller.signal,
              accountId,
              context,
              deliveredReplies: replyDispatch.deliveredReplies,
              emitFirstAssistantServerTiming,
              foldCommandBlocks: isInternalTextSlashCommandTurn || replyDispatchRun !== undefined,
              persistUserTurnTranscript: persistGatewayUserTurnTranscriptBestEffort,
              session,
              suppressReplies: !replyDispatchRun && replyDispatch.hasAppendedWebchatAgentMedia(),
              // Bound ACP writes its own transcript; the dashboard still needs its reply.
              runtimeOwnsTranscript:
                replyDispatchResult?.assistantTranscript?.agentId === agentId &&
                replyDispatchResult.assistantTranscript.sessionKey === sessionKey &&
                replyDispatchResult.assistantTranscript.sessionId ===
                  activeRunAbort.entry?.sessionId,
              state: runtimeCancelled ? "aborted" : "final",
              stopReason: runtimeOutcome?.stopReason,
            });
          } else if (!progressRefresh && !context.chatRunState.hasAbortMarker(clientRunId)) {
            finalizedSourceReply = await finalizeChatSendSourceReplies({
              requesterContext: ctx,
              abortSignal: activeRunAbort.controller.signal,
              accountId,
              context,
              deliveredReplies: replyDispatch.deliveredReplies,
              emitFirstAssistantServerTiming,
              hasReturnedAgentErrorPayloads: hasReturnedAgentError,
              session,
              suppressFinal: runtimeFailed,
            });
          }
          const shouldBroadcastAgentError =
            hasReturnedAgentError && (runtimeFailed || !finalizedSourceReply);
          if (!context.chatRunState.hasAbortMarker(clientRunId)) {
            if (shouldBroadcastAgentError) {
              broadcastChatError({
                context,
                runId: clientRunId,
                sessionKey,
                agentId,
                errorMessage: returnedAgentErrorMessage,
                errorKind: runtimeClassification === "timeout" ? "timeout" : undefined,
                stopReason: runtimeOutcome?.stopReason,
              });
            }
            const returnedAgentError = shouldBroadcastAgentError
              ? errorShape(
                  ErrorCodes.UNAVAILABLE,
                  returnedAgentErrorMessage ?? "agent returned an error payload",
                )
              : undefined;
            setGatewayDedupeEntry({
              dedupe: context.dedupe,
              key: `chat:${clientRunId}`,
              session: captureAgentJobSession(jobSessionBinding),
              entry: {
                ts: Date.now(),
                ok: !shouldBroadcastAgentError,
                payload: shouldBroadcastAgentError
                  ? {
                      runId: clientRunId,
                      status: runtimeClassification === "timeout" ? "timeout" : "error",
                      summary: returnedAgentErrorMessage ?? "agent returned an error payload",
                      ...(runtimeOutcome ? { endedAt: runtimeOutcome.endedAt } : {}),
                      ...(runtimeOutcome?.stopReason
                        ? { stopReason: runtimeOutcome.stopReason }
                        : {}),
                    }
                  : runtimeCancelled
                    ? buildAbortedChatSendPayload({
                        runId: clientRunId,
                        endedAt: runtimeOutcome?.endedAt ?? Date.now(),
                        stopReason: runtimeOutcome?.stopReason,
                      })
                    : {
                        runId: clientRunId,
                        status: progressRefresh && !queuedFollowup.isSteered() ? "completed" : "ok",
                        ...(replyDispatchResult?.terminalOutcome?.stopReason
                          ? { stopReason: replyDispatchResult.terminalOutcome.stopReason }
                          : {}),
                      },
                ...(returnedAgentError ? { error: returnedAgentError } : {}),
              },
            });
          }
        },
        {
          phase: "agent-turn",
          config: cfg,
          attributes: chatSendTraceAttributes,
        },
      );
      emitServerTiming(
        "post-dispatch-completed",
        {
          postDispatchMs: roundedChatSendTimingMs(performance.now() - postDispatchStartedAtMs),
        },
        dispatchStartedAtMs,
      );
    })
    .catch((error: unknown) => {
      diagnostics.finish();
      return dispatchErrorLifecycle.handleError(error);
    })
    .finally(() => replyAdmissionTicket?.release());
  void (async () => {
    try {
      await dispatch;
    } finally {
      // Empty, rejected, and interrupted turns still receive an independent title.
      releaseTitle(false);
      turnSettled.resolve();
      await dispatchErrorLifecycle.finalize();
      // Terminal lifecycle can precede owner release; publish exact liveness after cleanup.
      emitSessionsChanged(
        context,
        { sessionKey, agentId, reason: "agent.input.settled" },
        { accessChanged: false },
      );
      if (userTurnRecorder.isBlocked() && attachments.offloadedRefs.length > 0) {
        // A blocked turn persists only the redacted block reason — no media
        // markers — so the prepared inbound media stays unreferenced forever
        // (sweep is off by default). Same custody rule as the pre-ACK owner
        // in chat-send-admission.ts: unreferenced staged media is discarded.
        void discardPreparedInboundMedia(attachments.offloadedRefs);
      }
    }
  })();
  scheduleChatDashboardSessionTitle(
    { admittedSessionId, agentId, cfg, context, request, sessionKey, storePath },
    { released: titleReady.promise, settled: turnSettled.promise },
  );
}
