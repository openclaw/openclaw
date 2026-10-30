import { performance } from "node:perf_hooks";
import { createAgentRunRestartAbortError } from "../../agents/run-termination.js";
import { withoutGatewayToolCallerIdentity } from "../../agents/tools/gateway-caller-context.js";
import { lookupSessionGoalOperation } from "../../config/sessions/goals-operations-read.js";
import type { SessionGoalOperationResult } from "../../config/sessions/goals-operations.js";
import {
  composeSessionSourceAssertion,
  createDynamicSessionSourceAssertion,
} from "../../config/sessions/session-source-authority.js";
import { logVerbose } from "../../globals.js";
import { getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { clearAgentRunContext } from "../../infra/agent-run-registry.js";
import {
  emitDiagnosticsTimelineEvent,
  withDiagnosticsTimelineObserver,
} from "../../infra/diagnostics-timeline.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { isProgressCardRefreshInputProvenance } from "../../sessions/input-provenance.js";
import { recordSessionCreated } from "../../sessions/session-created.js";
import type { PersistedUserTurnMessage } from "../../sessions/user-turn-transcript.js";
import { extractTextFromChatContent } from "../../shared/chat-content.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { createLazyImportLoader } from "../../shared/lazy-promise.js";
import { resolveChatAbortDiagnosticReason } from "../chat-abort-diagnostics.js";
import { runOutsideOperatorToolGatewayAuthority } from "../operator-tool-gateway-authority.js";
import { readQueuedChatInputAdmission } from "../queued-chat-input-admission.js";
import { invalidateSkillAuthoringForOtherRequester } from "../skill-library-authoring.js";
import { startChatDispatch } from "./chat-send-agent-dispatch.js";
import type { StartChatDispatchParams } from "./chat-send-agent-dispatch.types.js";
import {
  bindChatSendPreparedMediaCustody,
  prepareChatSendAttachments,
} from "./chat-send-attachments.js";
import { createChatSendDashboardAuthority } from "./chat-send-dashboard-authority.js";
import { readChatSendDiagnostics, startChatSendDiagnostics } from "./chat-send-diagnostics.js";
import { handleChatSendSetupError } from "./chat-send-dispatch-errors.js";
import type { ChatSendExternalAuthorityAdmission } from "./chat-send-external-authority-contract.js";
import { acknowledgeCodexGoal } from "./chat-send-goal-ack.js";
import {
  createChatSendGoalCommitGuard,
  requiresRuntimeApprovedChatInput,
} from "./chat-send-goal-admission.js";
import { createChatSendMessageInjectionStarter } from "./chat-send-message-injection.js";
import type { ChatSendInternalOptions } from "./chat-send-options.js";
import { readChatSendRetryComparison } from "./chat-send-retry-comparison.js";
import { createChatSendSessionInitialization } from "./chat-send-session-binding.js";
import { prepareAndAdmitChatSend } from "./chat-send-setup.js";
import { prepareChatSendUserTurn } from "./chat-send-user-turn.js";
import { createChatSendPendingInputAdmission } from "./chat-send-work-admission.js";
import { prepareChatSendAckTiming } from "./chat-server-timing.js";
import { createGatewayChatUserTurnController } from "./chat-user-turn-recorder.js";
import { gatewayClientSessionCreator } from "./gateway-client-identity.js";
import { emitSessionsChanged } from "./session-change-event.js";
import { publishCommittedSessionGoalChange } from "./session-goal-change.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

const mediaDocumentContextLoader = createLazyImportLoader(
  () => import("../../media-understanding/file-context.js"),
);

/** Owns input custody and ACK timing through the detached dispatch handoff. */
export async function handleChatSendWithStorage(
  handlerOptions: GatewayRequestHandlerOptions,
  onAdmissionOwned?: () => Promise<boolean>,
  externalAuthorityAdmission?: ChatSendExternalAuthorityAdmission,
  options?: ChatSendInternalOptions,
  storage?: { release(): void; retain(): void },
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
  const setup = await prepareAndAdmitChatSend(
    handlerOptions,
    onAdmissionOwned,
    options,
    diagnostics,
    storage ? () => storage.release() : undefined,
  ).catch((error: unknown) => {
    releaseSessionAuthorization?.();
    throw error;
  });
  if (!setup) {
    releaseSessionAuthorization?.();
    return;
  }
  storage?.retain();
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
  const { systemInputProvenance, reconnectResumeRequested } = request;
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
  const commitInitialInput = req.method === "sessions.create";
  let commitFreshInput = admission.localInputAdmission || commitInitialInput;
  let inputAdmissionAttempted = false;
  let committedInput: { sessionId: string; lifecycleRevision?: string } | undefined;
  let releaseBeforeDispatch: void | (() => void) = undefined;
  let dashboardAuthority: Awaited<ReturnType<typeof createChatSendDashboardAuthority>> | undefined;
  try {
    const assertCustodyLifetimeCurrent = () => {
      admission.assertWorkAdmissionCurrent();
      if (sessionRoutingChanged(context.getRuntimeConfig())) {
        throw new Error("Session routing changed before input admission; refresh and retry.");
      }
    };
    let assertAcceptedInputCurrent: (() => void) | undefined;
    const pendingAdmission = createChatSendPendingInputAdmission({
      runId: clientRunId,
      expectedProfileId: req.expectedProfileId,
      sessionMutationAuthorization,
      sessionMutationCommitGuard,
      assertCustodyLifetimeCurrent,
      assertClientUploadAllowed: admission.assertClientUploadAllowed,
    });
    const assertUnacceptedInputCurrent = composeSessionSourceAssertion(
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
    const assertInputAdmissionCurrent = options?.stageCreatedInput
      ? createDynamicSessionSourceAssertion(
          () => assertAcceptedInputCurrent ?? assertUnacceptedInputCurrent,
          () => {
            throw new Error("Chat input custody changed before admission");
          },
        )
      : assertUnacceptedInputCurrent;
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
    const codexGoalCommitted = admission.codexGoalAdmission ? createDeferredCore() : undefined;
    const userTurn = createGatewayChatUserTurnController({
      onMessagePersisted: codexGoalCommitted?.resolve,
      ...setup,
      client,
      commitInitialInput,
      transcript: options?.transcript,
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
      admission.withInputCommitPublication(run, (source, committedEntry) => {
        committedInput = {
          sessionId: committedEntry.sessionId,
          lifecycleRevision: committedEntry.lifecycleRevision,
        };
        if (!entry) {
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
        }
        if (options?.stageCreatedInput) {
          assertAcceptedInputCurrent = pendingAdmission.assertAdmittedCurrent;
        }
        admission.bindAcceptedInputAuthority(pendingAdmission.assertAdmittedCurrent);
      });
    const persistGatewayUserTurnTranscript = (
      ...args: Parameters<typeof persistUserTurnTranscript>
    ) =>
      withDiagnosticsTimelineObserver(diagnostics.observeSpan, () =>
        withUserTurnInputPublication(() => persistUserTurnTranscript(...args)),
      );
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
      assertInputCurrent: assertInputAdmissionCurrent,
      userTurn,
    });
    const { ctx, isInternalTextSlashCommandTurn } = preparedUserTurn;
    // Retained inputs need queue custody even after the resume run has finished.
    commitFreshInput =
      !readQueuedChatInputAdmission(clientRunId) &&
      ((commitInitialInput && !requiresRuntimeApprovedChatInput(client)) ||
        (admission.localInputAdmission &&
          request.p.queueMode !== "steer" &&
          !messageInjectionTarget &&
          !isInternalTextSlashCommandTurn &&
          (admission.localGoalAdmission ||
            (userTurn.baseInput.display !== false &&
              (!systemInputProvenance || systemInputProvenance.kind === "external_user")))));
    admission.setPendingInputCleanup(async () => {
      try {
        const pending =
          userTurnRecorder.getPendingInputMessage?.() &&
          !userTurnRecorder.isPendingInputConsumed?.();
        const disposition = "cancelled";
        userTurnRecorder.finishPendingInput?.(disposition);
        if (pending && activeRunAbort.controller.signal.aborted) {
          const reason = resolveChatAbortDiagnosticReason(
            activeRunAbort.controller.signal,
            activeRunAbort.entry?.adapter,
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
    const stageInput =
      admission.codexGoalAdmission ||
      Boolean(
        entry?.sessionId &&
        userTurn.baseInput.display !== false &&
        (!systemInputProvenance ||
          systemInputProvenance.kind === "external_user" ||
          options?.stageCreatedInput === true) &&
        !isInternalTextSlashCommandTurn &&
        !request.goalOperation &&
        !commitFreshInput,
      );
    if (stageInput) {
      // ACK transfers input custody. Persist approved source bytes before dispatch.
      inputAdmissionAttempted = true;
      using stagePhase = diagnostics.scope("detail.persist.stage");
      const staged = await withDiagnosticsTimelineObserver(diagnostics.observeSpan, () =>
        userTurnRecorder.stageApproved?.({
          ...pendingAdmission,
        }),
      );
      stagePhase?.finish();
      if (userTurnRecorder.isPendingInputConsumed?.()) {
        const comparison = await readChatSendRetryComparison(session);
        assertInputAdmissionCurrent();
        admission.cleanupAdmittedRun();
        clearAgentRunContext(clientRunId, lifecycleGeneration);
        respond(
          true,
          {
            runId: clientRunId,
            status: "ok",
            ...(comparison?.messageSeq !== undefined ? { messageSeq: comparison.messageSeq } : {}),
          },
          undefined,
          { cached: true, runId: clientRunId },
        );
        return;
      }
      if (!staged) {
        throw new Error("Chat input was not durably admitted; refresh and retry.");
      }
      if (options?.stageCreatedInput) {
        // Only committed input custody can outlive the originating tool, while
        // the retained operator, destination and Gateway authority stay live.
        assertAcceptedInputCurrent = pendingAdmission.assertAdmittedCurrent;
      }
      admission.bindAcceptedInputAuthority(pendingAdmission.assertAdmittedCurrent);
      approvedInput = userTurnRecorder.getPendingInputMessage?.();
      emitSessionsChanged(
        context,
        { sessionKey, agentId: selectedAgent.agentId, reason: "send" },
        { accessChanged: false },
      );
    }
    let goalResult: SessionGoalOperationResult | undefined;
    if (commitFreshInput) {
      inputAdmissionAttempted = true;
      using transcriptPhase = diagnostics.scope("detail.persist.transcript");
      const persistedUserTurn = await persistGatewayUserTurnTranscript();
      transcriptPhase?.finish();
      approvedInput = persistedUserTurn?.message;
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
      if (!persistedUserTurn) {
        throw new Error("Chat input was not durably admitted; refresh and retry.");
      }
      if (lifecycleGeneration !== getAgentEventLifecycleGeneration()) {
        if (activeRunAbort.entry) {
          activeRunAbort.entry.adapter.abortStopReason = "restart";
        }
        activeRunAbort.controller.abort(createAgentRunRestartAbortError());
      }
      if (activeRunAbort.controller.signal.aborted) {
        finishAbortedChatSend();
        return;
      }
      if (sessionRoutingChanged(context.getRuntimeConfig())) {
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
      diagnostics,
      operatorAuthority: admission.operatorAuthority,
      target: messageInjectionTarget,
      sourceRef: admission.sourceRef,
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
    phase?.mark("response");
    admission.markInputAccepted();
    if (!admission.codexGoalAdmission) {
      respond(true, ackPayload, undefined, { runId: clientRunId });
    }
    phase?.finish();
    diagnostics.acknowledge();
    context.recordClientActivity?.(client);
    const chatSendAckedAtMs = chatSendTiming?.ackedAtMs ?? performance.now();
    // Dispatch owns execution from this point, including deferred and collected turns.
    releaseBeforeDispatch = undefined;
    const dispatch: StartChatDispatchParams = {
      ...setup,
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
        replyContextFieldsPromise,
      },
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
    };
    // Accepted work retains its source authority; the spawning tool and turn no longer
    // own reply preparation while the new runtime establishes its own caller context.
    const dispatched = withoutGatewayToolCallerIdentity(() =>
      runOutsideOperatorToolGatewayAuthority(() => startChatDispatch(dispatch)),
    );
    admittedCleanup.dispatched = true;
    if (codexGoalCommitted) {
      await acknowledgeCodexGoal({
        dispatch,
        committed: codexGoalCommitted.promise,
        dispatched,
        ackPayload,
        respond,
      });
    }
  } catch (err) {
    dashboardAuthority?.release();
    releaseBeforeDispatch?.();
    await handleChatSendSetupError({
      // Uncommitted Goal admissions may retry with their original identity. Committed
      // outcomes replay from the durable receipt instead of this transient error cache.
      cacheResult: request.goalOperation === undefined && !inputAdmissionAttempted,
      committedInput,
      admission,
      context,
      error: err,
      respond,
      session,
    });
  }
}
