// Detached chat.send dispatch owns runtime delivery, post-dispatch persistence, and terminalization.
import { performance } from "node:perf_hooks";
import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import { resolveProviderIdForAuth } from "../../agents/provider-auth-aliases.js";
import { runWithAgentWorkspaceReadiness } from "../../agents/workspace-readiness.js";
import { dispatchInboundMessageWithProjectedDispatcher } from "../../auto-reply/dispatch.js";
import type {
  GetReplyOptions,
  ReplyDispatchRun,
} from "../../auto-reply/get-reply-options.types.js";
import { isReplyPayloadStatusNotice } from "../../auto-reply/reply-payload.js";
import type { DispatchFromConfigResult } from "../../auto-reply/reply/dispatch-from-config.types.js";
import type { InternalGetReplyOptions } from "../../auto-reply/reply/get-reply.types.js";
import { REPLY_OPERATION_RUN_STATE } from "../../auto-reply/reply/reply-operation-run-state.js";
import {
  bindReplySourceInput,
  bindReplySourcePreparationRetry,
} from "../../auto-reply/reply/reply-source-binding.js";
import { isInternalSourceReplyChannel } from "../../auto-reply/reply/source-reply-delivery-mode.js";
import {
  measureDiagnosticsTimelineSpan,
  withDiagnosticsTimelineObserver,
} from "../../infra/diagnostics-timeline.js";
import { withExecRequestTurn } from "../../infra/exec-request-context.js";
import { isProgressCardRefreshInputProvenance } from "../../sessions/input-provenance.js";
import { trackSessionControllerSourceWork } from "../../sessions/session-controller.mailbox.js";
import {
  getRpcSourceIdentity,
  isRpcSourceRegistered,
} from "../../sessions/session-controller.rpc-sources.js";
import { withCurrentUserTurnInput } from "../../sessions/user-turn-transcript-runtime-context.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { captureAgentJobSession, setGatewayDedupeEntry } from "../agent-turn/agent-job.js";
import { updateChatRunProvider } from "../chat-abort.js";
import { discardPreparedInboundMedia } from "../chat-attachments.js";
import { prepareGatewaySkillLibraryTurn } from "../skill-library-authoring.js";
import { formatForLog } from "../ws-log.js";
import { buildAbortedChatSendPayload } from "./chat-abort-authorization.js";
import { broadcastChatDelta } from "./chat-broadcast.js";
import type { StartChatDispatchParams } from "./chat-send-agent-dispatch.types.js";
import { scheduleChatDashboardSessionTitle } from "./chat-send-background.js";
import { readChatSendReplyPayload } from "./chat-send-command-replies.js";
import {
  createChatSendDispatchErrorLifecycle,
  resolveChatSendReturnedOutcome,
} from "./chat-send-dispatch-errors.js";
import {
  createChatSendInjectionDisposition,
  finalizeAcceptedChatSendMessageInjection,
  settleChatSendMessageInjection,
} from "./chat-send-message-injection.js";
import { applyChatSendReplyContextFields } from "./chat-send-reply-context.js";
import { createChatSendReplyDispatch } from "./chat-send-reply-dispatch.js";
import { finalizeChatSendDispatchedReplies } from "./chat-send-reply-finalization.js";
import { createAcceptedChatSendRetry, waitForAcceptedChatSendRetry } from "./chat-send-retry.js";
import { finalizeChatSendSourceReplies } from "./chat-send-source-finalization.js";
import { registerChatSendToolEventRecipients } from "./chat-send-tool-event-recipients.js";
import { createChatSendTurnAdoptionLifecycle } from "./chat-send-turn-adoption.js";
import { applyChatSendManagedMedia } from "./chat-send-user-turn.js";
import {
  createOperatorChatSendServerTiming,
  roundedChatSendTimingMs,
} from "./chat-server-timing.js";
import { emitSessionsChanged } from "./session-change-event.js";
import { prepareSessionWorkspace } from "./session-create-project.js";

export function startChatDispatch(params: StartChatDispatchParams): Promise<void> {
  const {
    diagnostics,
    admissionStartedAt,
    admission,
    attachments,
    client,
    context,
    toolsAllow,
    skillLibrary,
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
  } = admission;
  const { agentId, cfg, clientRunId, expectedLeafEntryId, storePath, selectedAgent, sessionKey } =
    session;
  let { entry } = session;
  const { p, supportsTaskSuggestions } = request;
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
  const { beginCapturedMessageInjection, replyContextFieldsPromise } = injection;
  let messageInjectionAttempt: Awaited<ReturnType<typeof beginCapturedMessageInjection>>;

  const titleTurn = createDeferredCore();

  let agentRunStarted = false;
  let replyDispatchRun: ReplyDispatchRun | undefined;
  const isRunCurrent = () =>
    !activeRunAbort.controller.signal.aborted && isRpcSourceRegistered(activeRunAbort.entry);
  const replyDispatch = createChatSendReplyDispatch({
    getRuntimeConfig: context.getRuntimeConfig,
    assertWorkCurrent: admission.assertWorkAdmissionCurrent,
    requesterContext: ctx,
    accountId,
    prepareAssistantTranscriptMessage: params.prepareAssistantTranscriptMessage,
    isAgentRunStarted: () => agentRunStarted,
    isRunCurrent,
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
    sourceRef: admission.sourceRef,
    context,
    runId: clientRunId,
    controller: activeRunAbort.controller,
    sessionKey,
    agentId: selectedAgent.agentId,
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
  const injectionDisposition = createChatSendInjectionDisposition({
    controllerInput: admission.sourceRef.input,
    operatorAuthority: admission.operatorAuthority,
    turnAdoptionLifecycle: queuedFollowup.lifecycle,
    userTurnTranscriptRecorder: userTurnRecorder,
  });
  let acceptedMessageInjection = false;
  const dispatchDisposition = {
    isSteered: () => acceptedMessageInjection || queuedFollowup.isSteered(),
    isEnqueued: queuedFollowup.isEnqueued,
    isTerminal: queuedFollowup.isTerminal,
  };
  const dispatchErrorLifecycle = createChatSendDispatchErrorLifecycle({
    admission,
    hasObservedSideEffects: () =>
      acceptedMessageInjection ||
      messageInjectionAttempt !== undefined ||
      replyDispatch.deliveredReplies.length > 0,
    injectionDisposition,
    context,
    isAgentRunStarted: () => agentRunStarted,
    isQueuedFollowupEnqueued: () => queuedFollowup.isEnqueued() || queuedFollowup.isTerminal(),
    persistUserTurnTranscript: persistGatewayUserTurnTranscript,
    session,
    terminalizeRestartSafeAdmission,
    userTurnRecorder,
    isReplyDispatchRun: () => replyDispatchRun !== undefined,
  });
  const retryDispatch = createAcceptedChatSendRetry({
    classify: dispatchErrorLifecycle.classifyFailure,
    waitForRetry: (error) =>
      waitForAcceptedChatSendRetry(
        { agentId, sessionKey, storePath },
        error,
        activeRunAbort.controller.signal,
      ),
  });
  bindReplySourcePreparationRetry(admission.sourceRef.input, retryDispatch);
  const {
    emit: emitServerTiming,
    emitFirstAssistant: emitFirstAssistantServerTiming,
    dispatchStartedAtMs,
  } = createOperatorChatSendServerTiming(params);
  emitServerTiming("dispatch-started");
  const dispatchAdmission = {
    run: <T>(operation: () => Promise<T>) =>
      gatewayWorkAdmission.run(async () => {
        // Durable input custody owns the ACK. Steering may wait behind an older
        // queued turn, so only detached dispatch joins that ordered admission.
        phase?.mark("replyContext");
        if (replyContextFieldsPromise) {
          applyChatSendReplyContextFields(ctx, await replyContextFieldsPromise);
        }
        phase?.mark("runAdmission");
        using injectionPhase = diagnostics.scope("detail.run_admission.steer_prepare");
        messageInjectionAttempt = await withCurrentUserTurnInput(
          userTurnRecorder,
          beginCapturedMessageInjection,
        );
        injectionPhase?.mark("detail.run_admission.steer_settlement");
        acceptedMessageInjection = await settleChatSendMessageInjection(messageInjectionAttempt);
        messageInjectionAttempt = await injectionDisposition.observe(messageInjectionAttempt);
        injectionPhase?.finish();
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
          return getRpcSourceIdentity(admission.sourceRef).sessionId;
        },
        assertCurrent: assertDashboardReadCurrent,
      }
    : undefined;
  const phase = diagnostics.scope("dispatch");
  // Naming needs only the accepted message, not a ready workspace or reply progress.
  scheduleChatDashboardSessionTitle(
    { admittedSessionId, agentId, cfg, context, request, sessionKey, storePath },
    titleTurn.promise,
  );
  const dispatch = replyDispatch
    .runAgentMediaTranscript<DispatchFromConfigResult>(dispatchAdmission, () =>
      measureDiagnosticsTimelineSpan(
        "gateway.chat_send.dispatch_inbound",
        async () => {
          // Input already owned by the sink must finalize before source admission can fail.
          if (!acceptedMessageInjection) {
            admission.assertWorkAdmissionCurrent();
          }
          let workspacePreparation: ReturnType<typeof prepareSessionWorkspace> | undefined;
          if (
            !acceptedMessageInjection &&
            entry &&
            (Object.hasOwn(entry, "pendingProjectGitUrl") || entry.pendingWorktree)
          ) {
            phase?.mark("worktree");
            session.entry = entry = { ...entry };
            workspacePreparation = prepareSessionWorkspace({
              admission,
              client,
              context,
              session,
            });
            await workspacePreparation.promptReady;
            workspacePreparation.assertCurrent();
          }
          const assertWorkspaceRunOwnership = workspacePreparation?.assertCurrent;
          if (messageInjectionAttempt) {
            using _ = diagnostics.scope("detail.run_admission.steer_finalize");
            const injected = await finalizeAcceptedChatSendMessageInjection({
              attempt: messageInjectionAttempt,
              sourceRef: admission.sourceRef,
              context,
              ctx,
              persistUserTurnTranscriptBestEffort: persistGatewayUserTurnTranscriptBestEffort,
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
          const skillLibraryAuthoring = await prepareGatewaySkillLibraryTurn(
            skillLibrary,
            turn.prepareSessionCreation,
            () => phase?.mark("authoring"),
          );
          admission.assertWorkAdmissionCurrent();
          phase?.mark("preparation");
          const pluginBoundMedia = await pluginBoundMediaPromise;
          assertWorkspaceRunOwnership?.();
          applyChatSendManagedMedia(ctx, pluginBoundMedia, managedMediaApplyMode);
          phase?.mark("replyInitialization");
          const onAgentRunStart: NonNullable<GetReplyOptions["onAgentRunStart"]> = (
            runId,
            _identity,
            options,
            transcriptStart,
          ) => {
            queuedFollowup.onRunStarted(runId);
            diagnostics.finish();
            replyDispatchRun = options;
            if (activeRunAbort.markExecutionStarted()) {
              admission.armOperatorRunCancellation();
            }
            // A bound runtime can start on a different transcript than the source chat.
            agentRunStarted = true;
            replyDispatch.captureAgentTranscriptStart(runId, transcriptStart);
            emitServerTiming(
              "agent-run-started",
              runId !== clientRunId ? { agentRunId: runId } : undefined,
              dispatchStartedAtMs,
            );
            registerChatSendToolEventRecipients(
              { client, context, cfg, sessionKey, selectedAgent, storePath },
              runId,
            );
            return options?.completionSource;
          };
          const dispatchInbound = () => {
            assertWorkspaceRunOwnership?.();
            return dispatchInboundMessageWithProjectedDispatcher({
              ctx,
              cfg,
              toolsAllow,
              dispatcherOptions: replyDispatch.dispatcherOptions,
              onSessionMetadataChanges: (changes) =>
                changes.forEach((change) => emitSessionsChanged(context, change)),
              replyOptions: bindReplySourceInput<InternalGetReplyOptions>(
                {
                  [REPLY_OPERATION_RUN_STATE]: injectionDisposition.runState,
                  prepareAssistantTranscriptMessage:
                    replyDispatch.prepareAssistantTranscriptMessage,
                  ...(isInternalSourceReplyChannel(ctx)
                    ? {
                        resolveReplyDelivery: replyDispatch.resolveReplyDelivery,
                        resolveReplyDeliveryFacts: replyDispatch.resolveReplyDeliveryFacts,
                      }
                    : {}),
                  ...(admission.admittedSessionSettings
                    ? { admittedSessionSettings: admission.admittedSessionSettings }
                    : {}),
                  runId: clientRunId,
                  operatorAuthority: admission.operatorAuthority,
                  providerReviewAcknowledgment: request.providerReviewAcknowledgment,
                  forceRestartSafeTools: request.restartResume?.forceRestartSafeTools,
                  forceCodeModeTools: request.restartResume?.forceCodeModeTools,
                  dashboardReadAdmission,
                  skillLibraryAuthoring,
                  ...(cronCreatorAuthority
                    ? { cronCreatorAuthorityCapability: cronCreatorAuthority }
                    : {}),
                  ...(supportsTaskSuggestions
                    ? { taskSuggestionDeliveryMode: "gateway" as const }
                    : {}),
                  expectedActiveReplyOperation: admission.expectedActiveReplyOperation,
                  ...params.getSessionInitializationOptions(),
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
                    if (
                      client?.invalidated ||
                      !client?.connect.scopes?.includes("operator.admin")
                    ) {
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
                  ...(injectionDisposition.isRefused()
                    ? { messageInjectionDisposition: "collaborative-steering-disabled" as const }
                    : p.queueMode === "steer" && messageInjectionTarget
                      ? { messageInjectionDisposition: "rejected" as const }
                      : {}),
                  ...(restartSafeAdmission ? { suppressNextUserMessagePersistence: true } : {}),
                  fastModeAutoOnSecondsOverride: p.fastAutoOnSeconds,
                  onAgentRunStart,
                  onPreparedAgentRunStart: ({
                    runId,
                    executionIdentityToken,
                    options,
                    transcriptStart,
                  }) => onAgentRunStart(runId, executionIdentityToken, options, transcriptStart),
                  onModelSelected: (modelSelection) => {
                    updateChatRunProvider({
                      runId: clientRunId,
                      resolveGatewayContext: context.resolveGatewayContext,
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
                admission.sourceRef.input,
              ),
            });
          };
          const dispatchWithRetry = () =>
            withExecRequestTurn(
              {
                identity: {
                  runId: clientRunId,
                  ...getRpcSourceIdentity(admission.sourceRef),
                  ownerConnId: admission.sourceRef.adapter.requester?.connectionId,
                  ownerDeviceId: admission.sourceRef.adapter.requester?.deviceId,
                  controlUiVisible: admission.sourceRef.adapter.controlUiVisible,
                  turnKind: admission.sourceRef.adapter.turnKind,
                },
                abortSignal: activeRunAbort.controller.signal,
              },
              () =>
                retryDispatch(() =>
                  withDiagnosticsTimelineObserver(diagnostics.observeSpan, () =>
                    withCurrentUserTurnInput(userTurnRecorder, dispatchInbound),
                  ),
                ),
            );
          const runDispatch = () =>
            cronCreatorAuthority && externalAuthorityAdmission
              ? externalAuthorityAdmission.run(
                  cronCreatorAuthority,
                  dispatchWithRetry,
                  activeRunAbort.controller.signal,
                )
              : dispatchWithRetry();
          // A ready workspace still needs a fresh scope: internal continuations may retain
          // the previous chat run's preparation even after its ownership has ended.
          const dispatchResult = await runWithAgentWorkspaceReadiness(
            workspacePreparation,
            async () => {
              try {
                return await runDispatch();
              } finally {
                await workspacePreparation?.waitUntilReady();
              }
            },
          );
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
      diagnostics.finish(dispatchDisposition);
      await dispatchErrorLifecycle.settleRefusal(dispatchResult.collaborativeSteeringRefused);
      if (dispatchResult.deferredToActiveRun === "followup" && queuedFollowup.isEnqueued()) {
        const notices = replyDispatch.deliveredReplies
          .map(({ input }) => readChatSendReplyPayload(input))
          .filter(isReplyPayloadStatusNotice);
        if (notices.length > 0) {
          await queuedFollowup.onQueuedFollowupReplyBatch({
            kind: "queued-followup",
            runId: clientRunId,
            originatingChannel: admission.originatingRoute.originatingChannel,
            payloads: notices,
            completion: { kind: "progress" },
          });
        }
      }
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
          const {
            runtimeClassification,
            runtimeCancelled,
            runtimeFailed,
            returnedAgentErrorPayloads,
            hasOnlyFinalWarnings,
            hasReturnedAgentError,
            returnedAgentErrorMessage,
          } = resolveChatSendReturnedOutcome({
            dispatchResult,
            runtimeOutcome,
            deliveredReplies: replyDispatch.deliveredReplies,
            agentRunStarted,
            isInternalTextSlashCommandTurn,
            collaborativeSteeringRefused: dispatchResult.collaborativeSteeringRefused,
          });
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
          const replyFinalization = {
            terminalEntry: admission.sourceRef,
            requesterContext: ctx,
            abortSignal: activeRunAbort.controller.signal,
            accountId,
            context,
            deliveredReplies: replyDispatch.deliveredReplies,
            emitFirstAssistantServerTiming,
            session,
          };
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
              ...replyFinalization,
              foldCommandBlocks: isInternalTextSlashCommandTurn || replyDispatchRun !== undefined,
              persistUserTurnTranscript: persistGatewayUserTurnTranscriptBestEffort,
              suppressReplies: !replyDispatchRun && replyDispatch.hasAppendedWebchatAgentMedia(),
              // Bound ACP writes its own transcript; the dashboard still needs its reply.
              runtimeOwnsTranscript:
                replyDispatchResult?.assistantTranscript?.agentId === agentId &&
                replyDispatchResult.assistantTranscript.sessionKey === sessionKey &&
                replyDispatchResult.assistantTranscript.sessionId ===
                  getRpcSourceIdentity(activeRunAbort.entry).sessionId,
              state: runtimeCancelled ? "aborted" : "final",
              stopReason: runtimeOutcome?.stopReason,
            });
          } else if (!progressRefresh && !context.chatRunState.hasAbortMarker(clientRunId)) {
            finalizedSourceReply = await finalizeChatSendSourceReplies({
              ...replyFinalization,
              hasReturnedAgentErrorPayloads: hasReturnedAgentError,
              suppressFinal: runtimeFailed,
            });
          }
          const hasTerminalAgentError =
            dispatchResult.collaborativeSteeringRefused ||
            (hasReturnedAgentError && (runtimeFailed || !finalizedSourceReply));
          if (!context.chatRunState.hasAbortMarker(clientRunId)) {
            if (hasTerminalAgentError && !dispatchResult.collaborativeSteeringRefused) {
              dispatchErrorLifecycle.broadcastError({
                errorMessage: returnedAgentErrorMessage,
                errorKind: runtimeClassification === "timeout" ? "timeout" : undefined,
                stopReason: runtimeOutcome?.stopReason,
              });
            }
            const returnedAgentError = hasTerminalAgentError
              ? errorShape(
                  ErrorCodes.UNAVAILABLE,
                  returnedAgentErrorMessage ?? "agent returned an error payload",
                )
              : undefined;
            setGatewayDedupeEntry({
              dedupe: context.dedupe,
              key: `chat:${clientRunId}`,
              session: captureAgentJobSession({
                ...getRpcSourceIdentity(admission.sourceRef),
                lifecycleGeneration: admission.lifecycleGeneration,
              }),
              entry: {
                ts: Date.now(),
                ok: !hasTerminalAgentError,
                payload: hasTerminalAgentError
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
      diagnostics.finish(dispatchDisposition);
      return dispatchErrorLifecycle.handleError(error);
    });
  // Runtime completion must not retire the source before media and reply persistence settle.
  // Keep terminal cleanup outside this receipt because it can join source settlement.
  trackSessionControllerSourceWork(admission.sourceRef.input, dispatch);
  const completion = (async () => {
    try {
      await dispatch;
    } finally {
      // A failed overlapping label may retry after any terminal turn outcome.
      titleTurn.resolve();
      await dispatchErrorLifecycle.finalize();
      // Terminal lifecycle can precede owner release; publish exact liveness after cleanup.
      emitSessionsChanged(
        context,
        { sessionKey, agentId, reason: "agent.input.settled" },
        { accessChanged: false, rowScope: "runtime" },
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
  // Ordinary chat.send detaches completion; Goal acknowledgments still consume its rejection.
  void completion.catch((error: unknown) => {
    context.logGateway.warn(`webchat dispatch settlement failed: ${formatForLog(error)}`);
  });
  return completion;
}
