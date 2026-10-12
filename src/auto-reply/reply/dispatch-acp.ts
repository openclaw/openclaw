import {
  isSessionIdentityPending,
  resolveSessionIdentityFromMeta,
} from "@openclaw/acp-core/runtime/session-identity";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { normalizeUniqueTrimmedStringList } from "@openclaw/normalization-core/string-normalization";
import { resolveAcpAgentPolicyError, resolveAcpDispatchPolicyError } from "../../acp/policy.js";
import {
  AcpRuntimeError,
  formatAcpRuntimeErrorText,
  toAcpRuntimeError,
} from "../../acp/runtime/errors.js";
import {
  closeAdmittedRunDelegatedAuthority,
  getAdmittedRunDelegatedAuthority,
  type AdmittedRunContext,
} from "../../agents/admitted-run-context.js";
import { buildAgentRunTerminalOutcomeFromLifecycleEvent } from "../../agents/agent-run-terminal-outcome.js";
import { resolveSessionAgentId } from "../../agents/agent-scope.js";
import {
  PreparedQuestionAnswerRefusedError,
  QuestionAnswerUnconfirmedError,
} from "../../agents/harness/gateway-question-dispatch.js";
import { claimPreparedPendingAgentQuestionAnswer } from "../../agents/harness/gateway-question.js";
import { toolPolicyRestrictsTools } from "../../agents/tool-policy.js";
import { recordRuntimeActionDecision } from "../../audit/runtime-action-decision.js";
import { readChannelContextAdmissionEvidence } from "../../channels/message-access/admission-evidence.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import type { PrepareAssistantTranscriptMessage } from "../../config/sessions/transcript-assistant-delivery.js";
import { getGatewayLocalUserIngress } from "../../gateway/local-user-ingress.js";
import { logVerbose } from "../../globals.js";
import { isDiagnosticsEnabled } from "../../infra/diagnostic-events.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { generateSecureUuid } from "../../infra/secure-random.js";
import { markDiagnosticSessionProgress } from "../../logging/diagnostic.js";
import {
  stripExtractedFileImageMetadata,
  type ExtractedFileImage,
} from "../../media-understanding/extracted-file-images.js";
import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import { recordAcceptedSessionParticipantInput } from "../../sessions/session-participant-input-recording.js";
import { prepareChannelParticipantObservation } from "../../sessions/session-participant-input.js";
import { classifySessionStateActor } from "../../sessions/session-state-events.js";
import { bindUserTurnInput } from "../../sessions/user-turn-transcript-runtime-context.js";
import { createLazyPromise } from "../../shared/lazy-promise.js";
import { shouldDeferFinalTtsText } from "../../tts/captioned-final.js";
import { prepareTtsPreferences, type PreparedTtsPreferences } from "../../tts/tts-preferences.js";
import type {
  GetReplyOptions,
  ReplyDispatchRun,
  ReplyDispatchAssistantTranscript,
  SourceReplyDeliveryMode,
} from "../get-reply-options.types.js";
import type { FinalizedRuntimeMsgContext } from "../templating.js";
import { createLazyAcpElicitationHandler } from "./acp-elicitation-handler-lazy.js";
import { createAcpReplyProjector } from "./acp-projector.js";
import {
  collectDescribedImageAttachmentIndexes,
  resolveAgentTurnAttachments,
  resolveInlineAgentImageAttachments,
} from "./agent-turn-attachments.js";
import { prepareChannelRunAdmission } from "./channel-run-admission.js";
import { createAcpDispatchDeliveryCoordinator } from "./dispatch-acp-delivery.js";
import type { AcpDispatchDeliveryParams } from "./dispatch-acp-delivery.types.js";
import { finalizeAcpTurnOutput } from "./dispatch-acp-finalize.js";
import { prepareAcpMediaUnderstanding } from "./dispatch-acp-media.js";
import { resolveAcpTurnText } from "./dispatch-acp-prompt.js";
import type { InboundMessageAuditTerminalRecorder } from "./dispatch-from-config.audit.js";
import { appendRecentHistoryImageContext } from "./history-media.js";
import { hasInboundMediaForUnderstanding } from "./inbound-media.js";
import type { ReplyDispatchKind } from "./reply-dispatcher.types.js";
import { assertPreparedConversationBindingRouteCurrent } from "./session-conversation-binding.js";

const loadDispatchAcpManagerRuntime = createLazyPromise(
  () => import("./dispatch-acp-manager.runtime.js"),
);
const loadDispatchAcpAuditRuntime = createLazyPromise(
  () => import("../../agents/command/acp-lifecycle.js"),
);

const loadDispatchAcpTranscriptRuntime = createLazyPromise(
  () => import("./dispatch-acp-transcript.runtime.js"),
);

function resolveAcpRequestId(ctx: FinalizedRuntimeMsgContext): string {
  const id = ctx.MessageSidFull ?? ctx.MessageSid ?? ctx.MessageSidFirst ?? ctx.MessageSidLast;
  return (
    normalizeOptionalString(id) ??
    (typeof id === "number" || typeof id === "bigint" ? String(id) : generateSecureUuid())
  );
}

export type AcpDispatchAttemptResult = {
  queuedFinal: boolean;
  counts: Record<ReplyDispatchKind, number>;
};

export async function tryDispatchAcpReplyCore(
  params: Omit<
    AcpDispatchDeliveryParams,
    "agentId" | "ctx" | "suppressBlockUserDelivery" | "preparedTtsPreferences"
  > & {
    preparedTtsPreferences?: PreparedTtsPreferences;
    ctx: FinalizedRuntimeMsgContext;
    toolsAllow?: string[];
    images?: Array<{ data: string; mimeType: string }>;
    extractedFileImages?: ExtractedFileImage[];
    sourceReplyDeliveryMode?: SourceReplyDeliveryMode;
    shouldSendToolSummaries: () => Promise<boolean>;
    shouldSendFullToolDetails: () => Promise<boolean>;
    bypassForCommand: boolean;
    onAgentRunStart?: GetReplyOptions["onAgentRunStart"];
    userTurnTranscriptRecorder?: GetReplyOptions["userTurnTranscriptRecorder"];
    prepareAssistantTranscriptMessage?: PrepareAssistantTranscriptMessage;
    recordProcessed: InboundMessageAuditTerminalRecorder["note"];
    markIdle: (reason: string) => void;
  },
): Promise<AcpDispatchAttemptResult | null> {
  const sessionKey = normalizeOptionalString(params.sessionKey);
  if (!sessionKey || params.bypassForCommand) {
    return null;
  }
  prepareChannelParticipantObservation(params.ctx);
  const inputRecorder = params.userTurnTranscriptRecorder;
  const input = bindUserTurnInput(inputRecorder, () => params.abortSignal?.throwIfAborted());

  const { getAcpSessionManager, maybeUnbindStaleBoundConversations, prepareAcpDispatchStart } =
    await loadDispatchAcpManagerRuntime();
  const acpManager = getAcpSessionManager();
  const acpResolution = await acpManager.resolveSessionAsync({
    cfg: params.cfg,
    sessionKey,
    agentId: resolveSessionAgentId({
      config: params.cfg,
      sessionKey,
      fallbackAgentId: params.ctx.AgentId,
    }),
    assertCurrent: input.assertLifetimeCurrent,
  });
  await input.withCurrent(() => {});
  if (acpResolution.kind === "none") {
    return null;
  }
  const canonicalSessionKey = acpResolution.sessionKey;
  const transcriptSessionId =
    acpResolution.kind === "ready" ? acpResolution.entry?.sessionId : undefined;
  const acpAgentId = acpResolution.agentId;
  const participantTarget = {
    agentId: acpAgentId,
    sessionKey: canonicalSessionKey,
    storePath: resolveSessionStorePathCore(params.cfg.session?.store, { agentId: acpAgentId }),
    onError: (error: unknown) =>
      logVerbose(`dispatch-acp: participant persistence failed: ${formatErrorMessage(error)}`),
  };
  const progressSessionKeys = isDiagnosticsEnabled(params.cfg)
    ? normalizeUniqueTrimmedStringList([params.ctx.SessionKey, sessionKey, canonicalSessionKey])
    : [];
  const markAcpProgress =
    progressSessionKeys.length > 0
      ? () => {
          for (const key of progressSessionKeys) {
            markDiagnosticSessionProgress({ sessionKey: key });
          }
        }
      : undefined;

  const identityPendingBeforeTurn = isSessionIdentityPending(
    resolveSessionIdentityFromMeta(acpResolution.kind === "ready" ? acpResolution.meta : undefined),
  );
  const hasBoundConversationForSession = async (): Promise<boolean> => {
    const channel =
      normalizeOptionalLowercaseString(
        params.ctx.OriginatingChannel ?? params.ctx.Surface ?? params.ctx.Provider,
      ) ?? "";
    if (!channel) {
      return false;
    }
    const accountId = normalizeOptionalLowercaseString(params.ctx.AccountId) ?? "";
    const channels = params.cfg.channels as Record<
      string,
      { defaultAccount?: unknown } | undefined
    >;
    const configuredDefaultAccountId = channels?.[channel]?.defaultAccount;
    const normalizedAccountId =
      accountId || normalizeOptionalLowercaseString(configuredDefaultAccountId) || "default";
    const { listSessionBindingsBySessionAsync } = await loadDispatchAcpManagerRuntime();
    const bindings = await listSessionBindingsBySessionAsync(canonicalSessionKey);
    return bindings.some(
      (binding) =>
        normalizeOptionalLowercaseString(binding.conversation.channel) === channel &&
        (normalizeOptionalLowercaseString(binding.conversation.accountId) || "default") ===
          normalizedAccountId &&
        Boolean(normalizeOptionalString(binding.conversation.conversationId)),
    );
  };

  const shouldEmitResolvedIdentityNotice =
    !params.suppressUserDelivery &&
    identityPendingBeforeTurn &&
    ((params.ctx.MessageThreadId != null && String(params.ctx.MessageThreadId).trim() !== "") ||
      (await hasBoundConversationForSession()));

  const resolvedAcpAgent =
    acpResolution.kind === "ready"
      ? (normalizeOptionalString(acpResolution.meta.agent) ??
        normalizeOptionalString(params.cfg.acp?.defaultAgent) ??
        resolveAgentIdFromSessionKey(canonicalSessionKey))
      : resolveAgentIdFromSessionKey(canonicalSessionKey);
  const normalizedDispatchChannel = normalizeOptionalLowercaseString(
    params.ctx.OriginatingChannel ?? params.ctx.Surface ?? params.ctx.Provider,
  );
  const explicitDispatchAccountId = normalizeOptionalString(params.ctx.AccountId);
  const dispatchChannels = params.cfg.channels as
    | Record<string, { defaultAccount?: unknown } | undefined>
    | undefined;
  const defaultDispatchAccount =
    normalizedDispatchChannel == null
      ? undefined
      : dispatchChannels?.[normalizedDispatchChannel]?.defaultAccount;
  const effectiveDispatchAccountId =
    explicitDispatchAccountId ?? normalizeOptionalString(defaultDispatchAccount);
  const preparedTtsPreferences = params.preparedTtsPreferences ?? (await prepareTtsPreferences());
  await input.withCurrent(() => {});
  const shouldDeferVisibleTextForTts = shouldDeferFinalTtsText({
    preparedTtsPreferences,
    cfg: params.cfg,
    ttsAuto: params.sessionTtsAuto,
    agentId: acpAgentId,
    channelId: params.ttsChannel,
    accountId: effectiveDispatchAccountId,
    inboundAudio: params.inboundAudio,
  });
  let queuedFinal = false;
  const delivery = createAcpDispatchDeliveryCoordinator({
    ...params,
    preparedTtsPreferences,
    agentId: acpAgentId,
    sessionKey: canonicalSessionKey,
    suppressBlockUserDelivery: shouldDeferVisibleTextForTts,
  });
  const pendingAnswerText = params.ctx.agentText.trim();
  const persistInput = inputRecorder
    ? async () => {
        await input.withCurrent(() => {});
        await inputRecorder.persistApproved();
        await input.withCurrent(() => {});
        if (!inputRecorder.hasPersisted()) {
          throw new Error("ACP input must be durably committed before dispatch.");
        }
      }
    : undefined;
  try {
    if (
      pendingAnswerText &&
      !params.images?.length &&
      !params.extractedFileImages?.length &&
      !hasInboundMediaForUnderstanding(params.ctx) &&
      (await claimPreparedPendingAgentQuestionAnswer(
        {
          sessionKey: acpResolution.sessionKey,
          text: pendingAnswerText,
          sourceRecorder: inputRecorder,
          // The released question dispatcher retains its opaque synchronous source guard.
          authority: { kind: "run", assertCurrent: input.assertNativeCurrent },
        },
        () => assertPreparedConversationBindingRouteCurrent(params.ctx),
      ))
    ) {
      recordAcceptedSessionParticipantInput(params.ctx, participantTarget);
      const counts = params.dispatcher.getQueuedCounts();
      params.recordProcessed("completed", { reason: "acp_question_answer" });
      params.markIdle("message_completed");
      return { queuedFinal: false, counts };
    }
  } catch (error) {
    if (
      !(error instanceof QuestionAnswerUnconfirmedError) &&
      !(error instanceof PreparedQuestionAnswerRefusedError)
    ) {
      throw error;
    }
    // Throwing would make the reply hook fall through and execute the input again.
    // Settle refused or uncertain answers without bypassing delivery policy.
    params.recordProcessed("error", {
      reason:
        error instanceof QuestionAnswerUnconfirmedError
          ? "acp_question_answer_unconfirmed"
          : "acp_question_answer_refused",
      error: error.message,
    });
    // Delivery failure cannot reopen this prepared input for another route.
    const queuedNotice = await delivery
      .deliver("final", { text: error.message, isError: true })
      .catch((deliveryError: unknown) => {
        logVerbose(
          `dispatch-acp: question notice delivery failed: ${formatErrorMessage(deliveryError)}`,
        );
        return false;
      });
    params.markIdle("message_error");
    const counts = delivery.applyRoutedCounts(params.dispatcher.getQueuedCounts());
    return { queuedFinal: queuedNotice, counts };
  }
  const deliverDeferredTextFallback = async (): Promise<boolean> =>
    shouldDeferVisibleTextForTts ? await delivery.recoverBlockText() : false;
  const projector = createAcpReplyProjector({
    cfg: params.cfg,
    shouldSendToolSummaries: params.shouldSendToolSummaries,
    shouldSendFullToolDetails: params.shouldSendFullToolDetails,
    deliver: delivery.deliver,
    getConversationContext: () => params.ctx.agentText,
    onProgress: markAcpProgress,
    provider: params.ctx.Surface ?? params.ctx.Provider,
    accountId: effectiveDispatchAccountId,
  });

  const acpDispatchStartedAt = Date.now();
  const finishAttempt = (
    finalQueued: boolean,
    error?: AcpRuntimeError,
  ): AcpDispatchAttemptResult => {
    const counts = delivery.applyRoutedCounts(params.dispatcher.getQueuedCounts());
    const hasQueuedDelivery = counts.tool + counts.block + counts.final > 0 || finalQueued;
    const suppressionReason = hasQueuedDelivery
      ? undefined
      : delivery.getDeliverySuppressionReason();
    const acpStats = acpManager.getObservabilitySnapshot();
    logVerbose(
      `acp-dispatch: session=${sessionKey} outcome=${error ? `error code=${error.code}` : "ok"} latencyMs=${Date.now() - acpDispatchStartedAt} queueDepth=${acpStats.turns.queueDepth} activeRuntimes=${acpStats.runtimeCache.activeSessions}`,
    );
    params.recordProcessed("completed", {
      reason: error
        ? `acp_error:${normalizeLowercaseStringOrEmpty(error.code)}`
        : (suppressionReason ?? "acp_dispatch"),
    });
    params.markIdle("message_completed");
    return { queuedFinal: finalQueued, counts };
  };
  const requestId = resolveAcpRequestId(params.ctx);
  const existingRunId = normalizeOptionalString(params.runId);
  const auditOnly = existingRunId === undefined;
  let completionSource: ReplyDispatchRun["completionSource"] | undefined;
  const auditRunId = existingRunId ?? generateSecureUuid();
  const auditRuntime = await loadDispatchAcpAuditRuntime();
  const auditToolTracker = auditRuntime.createAcpToolLifecycleTracker();
  const auditContext = {
    runId: auditRunId,
    sessionKey: canonicalSessionKey,
    agentId: acpAgentId,
    auditOnly,
  };
  let auditStarted = false;
  let auditFinished = false;
  let auditTerminalOutcome: "blocked" | undefined;
  let auditStopReason: string | undefined;
  let auditResultStatus: "completed" | "cancelled" | undefined;
  let assistantTranscript: ReplyDispatchAssistantTranscript | undefined;
  let terminalOutcome: ReturnType<ReplyDispatchRun["getResult"]>["terminalOutcome"];
  const notifyDispatchStart = await prepareAcpDispatchStart({
    scope: participantTarget,
    sessionId: transcriptSessionId,
    runId: auditRunId,
    onAgentRunStart: params.onAgentRunStart,
    getResult: () => ({ assistantTranscript, terminalOutcome }),
  });
  await input.withCurrent(() => {});
  let auditEndFields: ReturnType<typeof auditRuntime.resolveAcpLifecycleEndFields> | undefined;
  const resolveAuditEndFields = () =>
    (auditEndFields ??= auditRuntime.resolveAcpLifecycleEndFields(
      params.abortSignal,
      auditStopReason,
      auditResultStatus,
    ));
  const emitAuditStart = () => {
    if (auditStarted) {
      return;
    }
    auditStarted = true;
    completionSource = notifyDispatchStart();
    auditRuntime.emitAcpLifecycleStart({
      ...auditContext,
      startedAt: Date.now(),
      completionSource,
    });
  };
  const emitAuditTerminal = (error?: AcpRuntimeError) => {
    if (auditFinished) {
      return;
    }
    emitAuditStart();
    auditFinished = true;
    const lifecycle = {
      ...auditContext,
      toolTracker: auditToolTracker,
      completionSource,
    };
    terminalOutcome = error
      ? auditRuntime.emitAcpLifecycleError({
          ...lifecycle,
          ...(params.abortSignal ? { abortSignal: params.abortSignal } : {}),
          ...(auditTerminalOutcome ? { terminalOutcome: auditTerminalOutcome } : {}),
          error,
        })
      : auditRuntime.emitAcpLifecycleEnd({ ...lifecycle, endFields: resolveAuditEndFields() });
  };
  // Hoisted so the failure path can persist the same user turn the success path
  // records: a bound ACP session must not silently diverge from the channel.
  let transcriptPromptText = "";
  // Set once the turn is actually dispatched. Attachment-only turns carry an
  // empty prompt, so prompt text alone cannot stand in for "a turn happened".
  let turnDispatched = false;
  // Exactly one transcript record per turn: a failure after the success write
  // (e.g. finalization throwing) must not append the same user turn twice.
  let transcriptPersistenceAttempted = false;
  const persistTranscript = async (finalText: string): Promise<void> => {
    if (transcriptPersistenceAttempted) {
      return;
    }
    transcriptPersistenceAttempted = true;
    // Capture before any persistence await so a later abort cannot rewrite the completed execution.
    terminalOutcome ??= buildAgentRunTerminalOutcomeFromLifecycleEvent({
      phase: "end",
      data: resolveAuditEndFields(),
    });
    const { persistAcpDispatchTranscript } = await loadDispatchAcpTranscriptRuntime();
    assistantTranscript = await persistAcpDispatchTranscript({
      cfg: params.cfg,
      sessionKey: canonicalSessionKey,
      agentId: acpAgentId,
      expectedSessionId: transcriptSessionId,
      promptText: transcriptPromptText,
      finalText,
      terminalOutcome,
      meta: acpResolution.kind === "ready" ? acpResolution.meta : undefined,
      threadId: params.ctx.MessageThreadId,
      userTurnTranscriptRecorder: params.userTurnTranscriptRecorder,
      prepareAssistantTranscriptMessage: params.prepareAssistantTranscriptMessage,
      assistantIdempotencyKey: existingRunId,
    });
  };
  let admittedRunContext: AdmittedRunContext | undefined;
  let nativeActionEvidenceRecorded = false;
  const recordUnsupportedNativeActionEvidence = () => {
    if (nativeActionEvidenceRecorded) {
      return;
    }
    nativeActionEvidenceRecorded = true;
    recordRuntimeActionDecision({
      token: admittedRunContext?.executionIdentityToken,
      family: "native-runtime",
      operation: "action-evidence",
      outcome: "not-applicable",
      coverageState: "unsupported",
      reasonCode: "native_action_callback_unsupported",
      owner: "acp-runtime",
      decisionBoundary: "acp-runtime.prompt-submitted",
      summary:
        "ACP runtime action evidence is unsupported because the adapter exposes no authoritative native-action callback.",
      missingEvidence: ["native.action_callback"],
      remediation: [
        {
          code: "instrument_native_action_callback",
          text: "Instrument an authoritative native-action callback in the ACP adapter before claiming action evidence.",
        },
      ],
    });
  };
  try {
    const dispatchPolicyError = resolveAcpDispatchPolicyError(params.cfg);
    if (dispatchPolicyError) {
      auditTerminalOutcome = "blocked";
      throw dispatchPolicyError;
    }
    if (
      (params.toolsAllow !== undefined &&
        !params.toolsAllow.some((entry) => normalizeLowercaseStringOrEmpty(entry) === "*")) ||
      toolPolicyRestrictsTools(params.ctx.ConversationToolPolicy)
    ) {
      auditTerminalOutcome = "blocked";
      throw new AcpRuntimeError(
        "ACP_DISPATCH_DISABLED",
        "This session's bound runtime cannot enforce its permission or tool policy; use an embedded runtime for this restricted conversation.",
      );
    }
    if (acpResolution.kind === "stale") {
      emitAuditTerminal(acpResolution.error);
      await maybeUnbindStaleBoundConversations({
        targetSessionKey: canonicalSessionKey,
        error: acpResolution.error,
      });
      const delivered = await delivery.deliver("final", {
        text: formatAcpRuntimeErrorText(acpResolution.error),
        isError: true,
      });
      return finishAttempt(delivered, acpResolution.error);
    }
    const agentPolicyError = resolveAcpAgentPolicyError(params.cfg, resolvedAcpAgent);
    if (agentPolicyError) {
      auditTerminalOutcome = "blocked";
      throw agentPolicyError;
    }
    // Resolve bytes once before understanding so marker accounting shares the same snapshot.
    const resolvedTurnAttachments = await resolveAgentTurnAttachments({
      ctx: params.ctx,
      cfg: params.cfg,
    });
    const extractedFileImages = await prepareAcpMediaUnderstanding({
      ctx: params.ctx,
      cfg: params.cfg,
      agentId: acpAgentId,
      attachmentIndexes: resolvedTurnAttachments.attachmentIndexes,
      extractedFileImages: params.extractedFileImages,
      signal: params.abortSignal,
    });
    params.abortSignal?.throwIfAborted();

    const promptText = params.ctx.agentText.trim();
    const describedImageIndexes = collectDescribedImageAttachmentIndexes(params.ctx);
    const recentHistoryStart =
      resolvedTurnAttachments.attachments.length -
      resolvedTurnAttachments.recentHistoryImages.length;
    const mediaAttachmentEntries = resolvedTurnAttachments.attachments.flatMap(
      (attachment, index) => {
        const sourceIndex = resolvedTurnAttachments.attachmentIndexes?.[index];
        return sourceIndex !== undefined &&
          !describedImageIndexes.has(sourceIndex) &&
          (describedImageIndexes.size === 0 || index < recentHistoryStart)
          ? [{ attachment, sourceIndex }]
          : [];
      },
    );
    const recentHistoryImages =
      describedImageIndexes.size === 0 ? resolvedTurnAttachments.recentHistoryImages : [];
    const inlineAttachments = resolveInlineAgentImageAttachments(params.images);
    const extractedAttachments = resolveInlineAgentImageAttachments(
      extractedFileImages.map(stripExtractedFileImageMetadata),
    );
    const useMediaAttachments =
      mediaAttachmentEntries.length > 0 &&
      !(
        mediaAttachmentEntries.length === recentHistoryImages.length &&
        (inlineAttachments.length > 0 || extractedAttachments.length > 0)
      );
    const attachments = [
      ...(useMediaAttachments
        ? mediaAttachmentEntries
        : inlineAttachments.map((attachment) => ({ attachment, sourceIndex: undefined }))),
      ...extractedAttachments.map((attachment, index) => ({
        attachment,
        sourceIndex: extractedFileImages[index]?.attachmentIndex,
      })),
    ]
      .map(({ attachment, sourceIndex }, sequence) => ({ attachment, sourceIndex, sequence }))
      .toSorted((left, right) => {
        if (left.sourceIndex !== undefined && right.sourceIndex !== undefined) {
          return left.sourceIndex - right.sourceIndex || left.sequence - right.sequence;
        }
        return left.sequence - right.sequence;
      })
      .map((entry) => entry.attachment);
    const turnPromptText = useMediaAttachments
      ? appendRecentHistoryImageContext({
          promptText,
          images: recentHistoryImages,
        })
      : promptText;
    transcriptPromptText = turnPromptText;
    if (!turnPromptText && attachments.length === 0) {
      const counts = delivery.applyRoutedCounts(params.dispatcher.getQueuedCounts());
      params.recordProcessed("completed", { reason: "acp_empty_prompt" });
      params.markIdle("message_completed");
      return { queuedFinal: false, counts };
    }

    admittedRunContext = await prepareChannelRunAdmission({
      cfg: params.cfg,
      runId: requestId,
      agentId: acpAgentId,
      ingressKind: "acp",
      boundary: "auto-reply.acp",
      evidence: readChannelContextAdmissionEvidence(params.ctx),
      gatewayLocalUserIngress: getGatewayLocalUserIngress(params.ctx),
    }).admit("acp");
    recordAcceptedSessionParticipantInput(params.ctx, participantTarget);
    const turnAdmission = admittedRunContext;
    const elicitationParams = {
      sourceSessionKey: sessionKey,
      targetSessionKey: canonicalSessionKey,
      outerRequestId: requestId,
      agentId: acpAgentId,
      runId: auditRunId,
      delivery,
      isActive: () =>
        params.abortSignal?.aborted !== true &&
        admittedRunContext === turnAdmission &&
        getAdmittedRunDelegatedAuthority(turnAdmission) !== undefined,
    };
    const onElicitation = createLazyAcpElicitationHandler(elicitationParams);
    // ACP can act before its terminal transcript arrives. Consume accepted input
    // before submission while leaving final assistant/outcome persistence below.
    await persistInput?.();
    // Start publications clear prior lifecycle facts; settle input before they can race its guard.
    emitAuditStart();
    try {
      await delivery.startReplyLifecycle();
    } catch (error) {
      logVerbose(`dispatch-acp: start reply lifecycle failed: ${formatErrorMessage(error)}`);
    }
    await assertPreparedConversationBindingRouteCurrent(params.ctx);
    const turnInput: Parameters<typeof acpManager.runTurn>[0] = {
      admittedRunContext,
      cfg: params.cfg,
      sessionKey: canonicalSessionKey,
      agentId: acpAgentId,
      provenance: classifySessionStateActor({
        inputProvenance: params.ctx.InputProvenance,
        sessionEffects: params.ctx.InboundEventKind === "room_event" ? "internal" : "visible",
      }).actorType,
      text: resolveAcpTurnText({
        promptText: turnPromptText,
        sourceReplyDeliveryMode: params.sourceReplyDeliveryMode,
      }),
      attachments: attachments.length > 0 ? attachments : undefined,
      mode: "prompt",
      requestId,
      ...(params.abortSignal ? { signal: params.abortSignal } : {}),
      onElicitation,
      onLifecycle: recordUnsupportedNativeActionEvidence,
      onEvent: async (event) => {
        auditRuntime.emitAcpRuntimeEvent({
          ...auditContext,
          toolTracker: auditToolTracker,
          ...(params.abortSignal ? { abortSignal: params.abortSignal } : {}),
          event,
        });
        if (event.type === "done") {
          auditStopReason = event.stopReason;
          auditResultStatus = event.status;
        }
        await projector.onEvent(event);
      },
    };
    await input.withCurrent(() => {
      if (getAdmittedRunDelegatedAuthority(turnAdmission) === undefined) {
        throw new Error("ACP turn admission ended before input dispatch.");
      }
      turnDispatched = true;
      return acpManager.runTurn(turnInput);
    });

    await projector.flush();
    await delivery.flushBlockText();
    if (auditResultStatus !== "cancelled" && !params.abortSignal?.aborted) {
      queuedFinal =
        (await finalizeAcpTurnOutput({
          preparedTtsPreferences,
          cfg: params.cfg,
          sessionKey: canonicalSessionKey,
          agentId: acpAgentId,
          delivery,
          inboundAudio: params.inboundAudio,
          sessionTtsAuto: params.sessionTtsAuto,
          ttsChannel: params.ttsChannel,
          ttsAccountId: effectiveDispatchAccountId,
          shouldDeferVisibleTextForTts,
          shouldEmitResolvedIdentityNotice,
          abortSignal: params.abortSignal,
        })) || queuedFinal;
    }
    // Recheck cancellation after final delivery settles so a late abort keeps
    // only confirmed output in the cancelled turn's transcript.
    if (auditResultStatus === "cancelled" || params.abortSignal?.aborted) {
      queuedFinal = (await deliverDeferredTextFallback()) || queuedFinal;
      await persistTranscript(await delivery.resolveAccumulatedDeliveredTranscriptText());
      queuedFinal =
        delivery.hasPendingAnswerDelivery() ||
        delivery.hasPendingFinalTtsMedia() ||
        delivery.hasDeliveredFinalReply() ||
        queuedFinal;
      const counts = delivery.applyRoutedCounts(params.dispatcher.getQueuedCounts());
      params.recordProcessed("completed", { reason: "acp_aborted" });
      params.markIdle("message_aborted");
      emitAuditTerminal();
      return { queuedFinal, counts };
    }

    await persistTranscript(delivery.getAccumulatedTranscriptText());

    const result = finishAttempt(queuedFinal);
    emitAuditTerminal();
    return result;
  } catch (err) {
    if (!turnDispatched && params.abortSignal?.aborted) {
      emitAuditTerminal();
      params.recordProcessed("completed", { reason: "acp_aborted" });
      params.markIdle("message_aborted");
      return {
        queuedFinal: false,
        counts: delivery.applyRoutedCounts(params.dispatcher.getQueuedCounts()),
      };
    }
    const acpError = toAcpRuntimeError({
      error: err,
      fallbackCode: "ACP_TURN_FAILED",
      fallbackMessage: "ACP turn failed before completion.",
    });
    emitAuditTerminal(acpError);
    await projector.flush();
    await delivery.flushBlockText();
    queuedFinal = (await deliverDeferredTextFallback()) || queuedFinal;
    await maybeUnbindStaleBoundConversations({
      targetSessionKey: canonicalSessionKey,
      error: acpError,
    });
    const errorText = formatAcpRuntimeErrorText(acpError);
    // Snapshot streamed output before delivering the error: delivery accumulates
    // what it sends, so reading after would fold the error text in twice.
    const partialText = delivery.getAccumulatedTranscriptText();
    const delivered = await delivery.deliver("final", {
      text: errorText,
      isError: true,
    });
    // Record what the channel actually showed. Without this a failed bound turn
    // leaves the ACP transcript empty while the user sees the reply, and the next
    // turn resumes from history that never mentions it. Setup failures before
    // dispatch have no user turn to attach the error to.
    if (turnDispatched) {
      await persistTranscript(partialText ? `${partialText}\n\n${errorText}` : errorText);
    }
    queuedFinal = queuedFinal || delivered;
    return finishAttempt(queuedFinal, acpError);
  } finally {
    if (admittedRunContext) {
      closeAdmittedRunDelegatedAuthority(admittedRunContext);
    }
  }
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
