import { hasOutboundReplyContent } from "openclaw/plugin-sdk/reply-payload";
import { hasCompletionMessageSessionSpawn } from "../../agents/accepted-session-spawn.js";
import { resolveSessionAgentId } from "../../agents/agent-scope.js";
import {
  hasCommittedSourceReplyDeliveryEvidence,
  hasCompletedSourceReplyDeliveryEvidence,
  hasVisibleCommittedMessagingToolDeliveryEvidence,
  resolveExplicitFinalSourceReplyDeliveryEvidence,
  resolveSourceReplyDelivery,
} from "../../agents/embedded-agent-runner/delivery-evidence.js";
import {
  createMissingReplyNotice,
  MISSING_REPLY_NOTICE_TEXT,
  isRequiredReplyExpectation,
  isSyntheticSourceReplyTurn,
  resolveClaimedReplyExpectation,
  resolveReplyCompletion,
  shouldDeliverMissingReplyNotice,
} from "../../agents/reply-completion.js";
import { buildAgentRuntimeDeliveryPlan } from "../../agents/runtime-plan/build.js";
import type { SessionDeliveryGeneration } from "../../config/sessions/session-delivery-generation.types.js";
import { logVerbose } from "../../globals.js";
import { defaultRuntime } from "../../runtime.js";
import { sessionDeliveryChannel } from "../../utils/delivery-context.read.js";
import { isInternalMessageChannel } from "../../utils/message-channel.js";
import {
  getReplyPayloadMetadata,
  isReplyPayloadTerminalContent,
  markReplyPayloadForSourceSuppressionDelivery,
  selectAutomationReplyPayloads,
} from "../reply-payload.js";
import type { ReplyPayload } from "../types.js";
import {
  normalizeAssistantFinalDeliveryText,
  resolveTerminalReplyDelivery,
} from "./agent-runner-core.js";
import type { AgentTurnExecutionResult } from "./agent-runner-execution.types.js";
import {
  markPostCompactionModelFailurePayload,
  renderPostCompactionModelFailurePayload,
} from "./agent-runner-failure-reply.js";
import type { AccountedAgentTurn } from "./agent-runner-result-accounting.js";
import { appendUsageLine, resolveResponseUsageLine } from "./agent-runner-usage-line.js";
import {
  resolveAutomationReplyState,
  retainAutomationReasoningWithFinal,
} from "./automation-reply-payloads.js";
import { deliverBlockReply } from "./block-reply-delivery.js";
import { resolveFollowupDeliveryPayloads } from "./followup-delivery-payloads.js";
import { createFollowupSpeechPreparer } from "./followup-delivery-tts.js";
import type { InternalGetReplyOptions } from "./get-reply.types.js";
import { resolveOriginMessageProvider } from "./origin-routing.js";
import { warnPrivateMessageToolFinal } from "./private-message-tool-final.js";
import { enqueueFollowupRun, resolveQueueSettings, type FollowupRun } from "./queue.js";
import type { AdmittedFollowupTurn, FollowupRunnerParams } from "./reply-agent-turn-preparation.js";
import type { ReplyDispatchKind } from "./reply-dispatcher.types.js";
import { isRoutableChannel, routeReply } from "./route-reply.js";
import {
  resolveFollowupReplyExpectation,
  resolveSourceReplyVisibilityPolicy,
} from "./source-reply-delivery-mode.js";
import {
  isReplyOperationStalledBeforeOutput,
  resolveStalledTurnNoticeText,
} from "./stalled-turn-recovery.js";
import { resolveStrandedReplyRecovery } from "./stranded-reply-recovery.js";
import { createTypingSignaler } from "./typing-mode.js";
import { buildWaitingStatusPayload } from "./waiting-status.js";

function resolveFollowupPayloadContext(turn: AdmittedFollowupTurn) {
  return {
    cfg: turn.config,
    messageProvider: turn.queued.run.messageProvider,
    originatingAccountId: turn.queued.originatingAccountId ?? turn.queued.run.agentAccountId,
    originatingChannel: turn.queued.originatingChannel,
    originatingChatType: turn.queued.originatingChatType,
    originatingReplyToMode: turn.queued.originatingReplyToMode,
    originatingTo: turn.queued.originatingTo,
    originatingThreadId: turn.queued.originatingThreadId,
  };
}

/** Resolves one final queued delivery action without performing transport I/O. */
export async function resolveFollowupDeliveryDecision(params: {
  turn: AdmittedFollowupTurn;
  execution: AgentTurnExecutionResult;
  accounting?: Pick<
    AccountedAgentTurn,
    | "providerUsed"
    | "modelUsed"
    | "terminalFailurePayload"
    | "payloadArray"
    | "usage"
    | "preserveUserFacingSessionState"
    | "replyUsageState"
  > & {
    compactionNotice?: ReplyPayload;
    diagnosticsPayload?: ReplyPayload;
  };
  opts?: InternalGetReplyOptions;
}) {
  const { turn, execution, accounting, opts } = params;
  if (turn.sendPolicy === "deny") {
    return { kind: "suppress" as const, reason: "send-policy" as const };
  }
  if (
    turn.queued.currentInboundEventKind === "room_event" &&
    !isInternalMessageChannel(turn.queued.originatingChannel)
  ) {
    return { kind: "suppress" as const, reason: "room-event" as const };
  }
  const sourcePolicy = resolveSourceReplyVisibilityPolicy({
    cfg: turn.config,
    scheduledAutomation: turn.queued.run.scheduledAutomation !== undefined,
    ctx: {
      ChatType: turn.queued.originatingChatType ?? turn.queued.run.chatType,
      InboundEventKind: turn.queued.currentInboundEventKind,
      Provider: turn.queued.originatingChannel ?? turn.queued.run.messageProvider,
      Surface: turn.queued.originatingChannel ?? turn.queued.run.messageProvider,
    },
    requested: turn.queued.run.sourceReplyDeliveryMode ?? opts?.sourceReplyDeliveryMode,
    sendPolicy: turn.sendPolicy,
  });
  const terminalReplyExpectation = resolveFollowupReplyExpectation(turn.queued, turn.config);
  const isInteractive =
    isRequiredReplyExpectation(terminalReplyExpectation) ||
    (!isSyntheticSourceReplyTurn({
      inputProvenance: turn.queued.run.inputProvenance,
      scheduledAutomation: turn.queued.run.scheduledAutomation !== undefined,
    }) &&
      !isInternalMessageChannel(
        turn.queued.originatingChannel ?? turn.queued.run.messageProvider,
      ) &&
      Boolean(
        turn.queued.originatingTo?.trim() ||
        opts?.onBlockReply ||
        turn.queued.queuedFollowupReplyDisposition?.kind === "deliver",
      ));
  const deliveryContext = resolveFollowupPayloadContext(turn);
  const preparePayloads = (
    payloads: ReplyPayload[],
    options: Omit<
      Parameters<typeof resolveFollowupDeliveryPayloads>[0],
      "payloads" | keyof typeof deliveryContext
    > = {},
  ) => resolveFollowupDeliveryPayloads({ ...deliveryContext, ...options, payloads });
  if (execution.outcome.kind === "aborted") {
    // The one recovery run for a stalled turn stalled too: the notice is the last resort.
    // Like the dispatch-owned notice it replaces, it bypasses message-tool-only suppression.
    if (
      turn.queued.stalledTurnRecovery === true &&
      isReplyOperationStalledBeforeOutput(turn.operation)
    ) {
      const payloads = preparePayloads([
        markReplyPayloadForSourceSuppressionDelivery({
          text: resolveStalledTurnNoticeText(turn.operation),
          isError: true,
        }),
      ]);
      if (payloads.length > 0) {
        return { kind: "deliver" as const, payloads };
      }
    }
    return { kind: "suppress" as const, reason: "aborted" as const };
  }
  const postCompactionModelFailure = execution.outcome.postCompactionModelFailure;
  const renderFailurePayloads = (payloads: ReplyPayload[]) =>
    payloads.map((payload) =>
      renderPostCompactionModelFailurePayload(
        markPostCompactionModelFailurePayload(postCompactionModelFailure, payload),
      ),
    );
  if (execution.outcome.kind === "rejected") {
    if (!isInteractive) {
      return { kind: "suppress" as const, reason: "silent" as const };
    }
    if (
      sourcePolicy.sourceReplyDeliveryMode === "message_tool_only" &&
      getReplyPayloadMetadata(execution.outcome.payload)?.deliverDespiteSourceReplySuppression !==
        true
    ) {
      return { kind: "suppress" as const, reason: "message-tool-only" as const };
    }
    const payloads = renderFailurePayloads(
      preparePayloads([execution.outcome.payload], {
        reasoningPayloadsEnabled: opts?.reasoningPayloadsEnabled === true,
        commentaryPayloadsEnabled: opts?.commentaryPayloadsEnabled === true,
      }),
    );
    return payloads.length > 0
      ? {
          kind: "deliver" as const,
          payloads,
          resolved: execution.outcome.resolved,
        }
      : { kind: "suppress" as const, reason: "silent" as const };
  }
  if (!accounting) {
    return { kind: "suppress" as const, reason: "silent" as const };
  }
  const runtimeResolved = {
    provider: accounting.providerUsed,
    model: accounting.modelUsed,
  };
  const result = execution.outcome.result;
  const terminalRunFailed = execution.outcome.status === "failed";
  const missingReplyNoticeAllowed = shouldDeliverMissingReplyNotice({
    ...turn.queued.run,
    scheduledAutomation: turn.queued.run.scheduledAutomation !== undefined,
    terminalReplyExpectation,
    trigger: turn.queued.run.internalEventExecution ? "event" : "user",
    currentInboundEventKind: turn.queued.currentInboundEventKind,
  });
  const { authoredSilence, pendingContinuation, automationNoChange, reasoningPayloadsEnabled } =
    resolveAutomationReplyState(execution.outcome, {
      opts,
      terminalFailurePayload: accounting.terminalFailurePayload,
    });
  const directBlockDeliveries = execution.outcome.directBlockDeliveries;
  const sourceReplyDelivery = resolveSourceReplyDelivery(
    result,
    await resolveTerminalReplyDelivery({
      directBlockDeliveries,
      resolveReplyDelivery: opts?.resolveReplyDelivery,
      sourceReplyDeliveryState: result.sourceReplyDeliveryState,
    }),
  );
  let completion = resolveReplyCompletion(
    resolveClaimedReplyExpectation(terminalReplyExpectation, result.meta),
    result.meta?.error?.kind === "hook_block" || result.didSendDeterministicApprovalPrompt === true
      ? "blocked"
      : authoredSilence
        ? "silent"
        : sourceReplyDelivery !== "missing"
          ? sourceReplyDelivery
          : automationNoChange
            ? "silent"
            : pendingContinuation
              ? "pending"
              : "empty",
  );
  const explicitSilence = completion.outcome === "silent";
  const sourcePayloads = selectAutomationReplyPayloads(
    accounting.payloadArray,
    automationNoChange,
    authoredSilence,
  );
  if ((explicitSilence || automationNoChange) && sourcePayloads.length === 0) {
    return { kind: "suppress" as const, reason: "silent" as const };
  }
  const completedSourceDelivery = hasCompletedSourceReplyDeliveryEvidence(result);
  const hasLegacyMessagingToolEvidence =
    result.sourceReplyDeliveryState === undefined &&
    resolveExplicitFinalSourceReplyDeliveryEvidence(result) === undefined;
  const assistantFinalText = normalizeAssistantFinalDeliveryText(
    result.meta?.finalAssistantVisibleText ?? "",
  );
  let payloads = preparePayloads(sourcePayloads, {
    reasoningPayloadsEnabled,
    commentaryPayloadsEnabled: opts?.commentaryPayloadsEnabled === true,
    sentMediaUrls: result.messagingToolSentMediaUrls,
    sentTargets: result.messagingToolSentTargets,
    sentTexts: result.messagingToolSentTexts,
    onDeliveredTerminalDuplicate: hasLegacyMessagingToolEvidence
      ? () => {
          if (completion.outcome !== "blocked") {
            completion = resolveReplyCompletion(terminalReplyExpectation, "delivered");
          }
        }
      : undefined,
  });
  if (!completedSourceDelivery && completion.outcome === "delivered") {
    await opts?.onObservedReplyDelivery?.();
  }
  const recovery =
    explicitSilence ||
    terminalRunFailed ||
    !missingReplyNoticeAllowed ||
    completion.outcome !== "missing"
      ? ({ kind: "none" } as const)
      : resolveStrandedReplyRecovery({
          base: turn.queued,
          payloads,
          finalText: assistantFinalText,
          terminalReply: result.meta?.terminalReply,
          sourceReplyDeliveryMode: sourcePolicy.sourceReplyDeliveryMode,
          sendPolicyDenied: sourcePolicy.sendPolicyDenied,
          successfulSourceReplyDelivery: completedSourceDelivery,
          isRoomEvent: false,
        });
  if (recovery.kind === "retry") {
    return {
      kind: "retry-source-delivery" as const,
      run: recovery.run,
      finalTextLength: assistantFinalText.trim().length,
      resolved: runtimeResolved,
    };
  }
  if (recovery.kind === "diagnostic") {
    const [payload] = preparePayloads([recovery.payload]);
    return payload
      ? { kind: "deliver" as const, payloads: [payload], resolved: runtimeResolved }
      : { kind: "suppress" as const, reason: "silent" as const };
  }
  const hasTerminalPayload = payloads.some(
    (payload) =>
      isReplyPayloadTerminalContent(payload) &&
      // Private terminal content is not an empty result. Source visibility is
      // enforced below; genuine failures and yield acknowledgments still win.
      ((!terminalRunFailed && !pendingContinuation) ||
        sourcePolicy.sourceReplyDeliveryMode !== "message_tool_only" ||
        getReplyPayloadMetadata(payload)?.deliverDespiteSourceReplySuppression === true),
  );
  if (!hasTerminalPayload && completion.outcome === "missing" && !turn.operation.result) {
    turn.operation.fail("run_failed", new Error(MISSING_REPLY_NOTICE_TEXT));
    opts?.onAgentRunTerminalOutcome?.("failed");
  }
  const waitingStatusParams = {
    completion,
    continuationPending: result.meta?.continuationPending === true,
    mediaContinuation:
      result.meta?.continuationPending === true &&
      !hasCompletionMessageSessionSpawn(result.acceptedSessionSpawns),
    yielded: result.meta?.yielded === true,
    yieldAcknowledgment: result.meta?.yieldAcknowledgment,
    // Child spawns are side effects, not user-visible messages. They must not
    // suppress the explicit waiting reply for the parent turn.
    hasVisibleMessageDelivery:
      hasCommittedSourceReplyDeliveryEvidence(result) ||
      hasVisibleCommittedMessagingToolDeliveryEvidence(result) ||
      result.didSendDeterministicApprovalPrompt === true,
  };
  const waitingStatusPayload = terminalRunFailed
    ? undefined
    : buildWaitingStatusPayload(waitingStatusParams);
  const fallbackPayload = terminalRunFailed
    ? accounting.terminalFailurePayload &&
      isInteractive &&
      completion.outcome !== "delivered" &&
      completion.outcome !== "pending" &&
      completion.outcome !== "blocked"
      ? sourcePolicy.sourceReplyDeliveryMode === "message_tool_only"
        ? markReplyPayloadForSourceSuppressionDelivery(accounting.terminalFailurePayload)
        : accounting.terminalFailurePayload
      : undefined
    : (waitingStatusPayload ??
      (missingReplyNoticeAllowed && completion.outcome === "missing"
        ? createMissingReplyNotice()
        : undefined));
  if (!hasTerminalPayload && fallbackPayload) {
    payloads.push(...preparePayloads([fallbackPayload]));
  }
  if (accounting.compactionNotice) {
    payloads.unshift(...preparePayloads([accounting.compactionNotice]));
  }
  if (accounting.diagnosticsPayload && payloads.length > 0) {
    payloads.push(...preparePayloads([accounting.diagnosticsPayload]));
  }
  const responseUsageLine = resolveResponseUsageLine({
    config: turn.config,
    agentDir: turn.queued.run.agentDir,
    sessionRaw: turn.session.current()?.responseUsage,
    channel: resolveOriginMessageProvider({
      originatingChannel: turn.queued.originatingChannel,
      provider: turn.queued.run.messageProvider,
    }),
    usage: accounting.usage,
    provider: accounting.providerUsed,
    model: accounting.modelUsed,
    preserveUserFacingSessionState: accounting.preserveUserFacingSessionState,
    replyUsageState: accounting.replyUsageState,
  });
  let sourceUsageFooter: ReplyPayload | undefined;
  if (responseUsageLine) {
    if (
      sourcePolicy.sourceReplyDeliveryMode === "message_tool_only" &&
      hasCompletedSourceReplyDeliveryEvidence(result)
    ) {
      sourceUsageFooter = markReplyPayloadForSourceSuppressionDelivery({
        text: responseUsageLine,
        isStatusNotice: true,
      });
    } else {
      payloads = appendUsageLine(payloads, responseUsageLine);
    }
  }
  payloads = renderFailurePayloads(payloads);
  if (sourceUsageFooter) {
    payloads = [...payloads, sourceUsageFooter];
  }
  if (sourcePolicy.sourceReplyDeliveryMode === "message_tool_only") {
    payloads = payloads.filter(
      (payload) => getReplyPayloadMetadata(payload)?.deliverDespiteSourceReplySuppression === true,
    );
    if (payloads.length === 0) {
      return { kind: "suppress" as const, reason: "message-tool-only" as const };
    }
  }
  if (execution.outcome.automation) {
    payloads = retainAutomationReasoningWithFinal(payloads);
  }
  return payloads.length > 0
    ? { kind: "deliver" as const, payloads, resolved: runtimeResolved }
    : { kind: "suppress" as const, reason: "silent" as const };
}

export async function deliverFollowupDecision(params: {
  decision: Awaited<ReturnType<typeof resolveFollowupDeliveryDecision>>;
  turn: AdmittedFollowupTurn;
  defaults: FollowupRunnerParams;
  runId: string;
  runFollowup: (run: FollowupRun) => Promise<void>;
  kind?: ReplyDispatchKind;
  onObservedReplyDelivery?: () => Promise<void> | void;
}) {
  const { decision, turn, defaults } = params;
  if (decision.kind === "suppress") {
    turn.queued.run.internalEventExecution?.onSuppressed?.(decision.reason);
    logVerbose(`followup queue: delivery suppressed (${decision.reason})`);
    return { kind: "completed" as const, payloads: [] };
  }
  let payloads: ReplyPayload[];
  if (decision.kind === "retry-source-delivery") {
    warnPrivateMessageToolFinal({
      sessionKey: turn.session.kind === "session" ? turn.session.key : undefined,
      channel:
        turn.queued.originatingChannel ??
        turn.queued.run.messageProvider ??
        sessionDeliveryChannel(turn.session.current()),
      finalTextLength: decision.finalTextLength,
    });
    const key = turn.session.kind === "session" ? turn.session.key : turn.queued.run.sessionKey;
    const retrySourceDisposition = turn.queued.queuedFollowupReplyDisposition;
    const retryDelivery =
      retrySourceDisposition?.kind === "deliver"
        ? retrySourceDisposition.deliver.createSourceRetry?.()
        : undefined;
    // A sanctioned stranded-final retry is a new input, not replay of the
    // consumed source or its already-released controller claim.
    const retryRun = {
      ...decision.run,
      controllerInput: undefined,
      controllerClaim: undefined,
      ...(retryDelivery
        ? { queuedFollowupReplyDisposition: { kind: "deliver" as const, deliver: retryDelivery } }
        : {}),
    };
    const enqueued =
      key &&
      enqueueFollowupRun(
        key,
        retryRun,
        resolveQueueSettings({
          cfg: turn.config,
          channel: turn.queued.originatingChannel ?? turn.queued.run.messageProvider,
          sessionEntry: turn.session.current(),
        }),
        "none",
        params.runFollowup,
        false,
        {
          position: "front",
          storePath: turn.session.kind === "session" ? turn.session.storePath : undefined,
        },
      );
    if (enqueued) {
      return { kind: "source-retry" as const };
    }
    payloads = resolveFollowupDeliveryPayloads({
      ...resolveFollowupPayloadContext(turn),
      payloads: [createMissingReplyNotice()],
    });
  } else {
    payloads = decision.payloads;
  }
  const runId = params.runId;
  const kind = params.kind ?? "final";
  const mirror =
    decision.kind === "deliver" && params.kind && params.kind !== "final" ? false : undefined;
  const resolved = decision.resolved;
  const onObservedReplyDelivery = params.onObservedReplyDelivery;
  const { originatingChannel, originatingTo } = turn.queued;
  const originRoutable = Boolean(isRoutableChannel(originatingChannel) && originatingTo);
  const deliveryPlan = buildAgentRuntimeDeliveryPlan({
    provider: resolved?.provider ?? turn.queued.run.provider,
    modelId: resolved?.model ?? turn.queued.run.model,
    config: turn.config,
    workspaceDir: turn.queued.run.workspaceDir,
    agentDir: turn.queued.run.agentDir,
  });
  payloads = payloads.filter((payload) => hasOutboundReplyContent(payload));
  if (payloads.length === 0) {
    return { kind: "completed" as const, payloads: [] };
  }
  const sourceDisposition = turn.queued.queuedFollowupReplyDisposition;
  if (sourceDisposition?.kind === "drop") {
    logVerbose(`followup queue: source delivery dropped (${sourceDisposition.reason})`);
    return { kind: "completed" as const, payloads: [] };
  }
  const deliverQueuedBatch = sourceDisposition?.deliver;
  if (
    turn.queued.run.internalEventExecution ||
    deliverQueuedBatch?.ownsCompletion?.(originatingChannel)
  ) {
    if (!deliverQueuedBatch) {
      throw new Error("Internal event lost its originating delivery owner");
    }
    if (kind !== "final") {
      await deliverQueuedBatch({
        kind: "queued-followup",
        runId,
        originatingChannel,
        payloads,
        completion: { kind: "progress" },
      });
    }
    return { kind: "completed" as const, payloads };
  }
  const fallbackDispatcher = sourceDisposition ? undefined : defaults.opts?.onBlockReply;
  const dispatcherAvailable = Boolean(deliverQueuedBatch || fallbackDispatcher);
  if (!originRoutable && !dispatcherAvailable) {
    defaultRuntime.error?.(
      "followup queue: completed with payloads but no origin route or visible dispatcher is available",
    );
    return { kind: "completed" as const, payloads: [] };
  }
  const typing = createTypingSignaler({
    typing: defaults.typing,
    mode: defaults.typingMode,
  });
  const crossChannelFailures: ReplyPayload[] = [];
  const queuedPayloads: ReplyPayload[] = [];
  let pending = false;
  const dispatchPayload = async (payload: ReplyPayload) => {
    if (deliverQueuedBatch) {
      queuedPayloads.push(payload);
    } else if (fallbackDispatcher) {
      const delivery = await deliverBlockReply(() => fallbackDispatcher(payload));
      pending ||= delivery.pending === true || delivery.outcome === "recovery-owned";
      if (
        delivery.outcome === "delivered" &&
        !delivery.pending &&
        (!originRoutable || sameChannelOrigin)
      ) {
        await onObservedReplyDelivery?.();
      }
    }
  };
  let deliveredCrossChannelOrigin = false;
  const provider = resolveOriginMessageProvider({
    provider: turn.queued.run.messageProvider,
  });
  const origin = resolveOriginMessageProvider({ originatingChannel });
  const sameChannelOrigin = Boolean(origin && origin === provider);
  const crossChannelOrigin = Boolean(origin && provider && origin !== provider);
  const prepareSpeech = createFollowupSpeechPreparer({ turn, defaults, kind });
  // The operation holds lifecycle admission until queue handoff. Retain its
  // current generation so recovery cannot adopt a later reset's session.
  const entry = turn.session.current();
  const sessionGeneration: SessionDeliveryGeneration | undefined =
    turn.session.kind === "session" && turn.session.storePath && entry
      ? {
          agentId: resolveSessionAgentId({
            sessionKey: turn.session.key,
            config: turn.config,
            fallbackAgentId: turn.queued.run.agentId,
          }),
          storePath: turn.session.storePath,
          sessionKey: turn.session.key,
          sessionId: entry.sessionId,
          lifecycleRevision: entry.lifecycleRevision ?? null,
        }
      : undefined;
  for (let payload of payloads) {
    const providerRoute = deliveryPlan.resolveFollowupRoute({
      payload,
      originatingChannel,
      originatingTo,
      originRoutable,
      dispatcherAvailable,
    });
    if (providerRoute?.route === "drop") {
      continue;
    }
    const route =
      providerRoute?.route === "origin" && originRoutable
        ? "origin"
        : providerRoute?.route === "dispatcher" && dispatcherAvailable
          ? "dispatcher"
          : originRoutable
            ? "origin"
            : "dispatcher";
    if (route === "origin") {
      // Retain every collected source's policy: an explicit request must not be
      // silenced by a passive message sharing the same follow-up batch.
      const suppressions = (turn.queued.deliveryCorrelations ?? []).flatMap((correlation) =>
        correlation.shouldSuppressReply ? [correlation.shouldSuppressReply(payload)] : [],
      );
      if (suppressions.length > 0 && suppressions.every(Boolean)) {
        logVerbose("followup queue: origin reply suppressed by source policy");
        continue;
      }
    }
    await typing.signalTextDelta(payload.text);
    // The stalled recovery owner delivers its terminal notice after the operation aborts.
    if (
      turn.queued.stalledTurnRecovery !== true ||
      !isReplyOperationStalledBeforeOutput(turn.operation)
    ) {
      payload = await prepareSpeech(payload, route);
    }
    if (route !== "origin") {
      await dispatchPayload(payload);
    } else if (isRoutableChannel(originatingChannel) && originatingTo) {
      const metadata = getReplyPayloadMetadata(payload);
      const result = await routeReply({
        payload,
        channel: originatingChannel,
        to: originatingTo,
        agentId: turn.queued.run.agentId,
        sessionKey: turn.queued.run.sessionKey,
        sessionGeneration,
        accountId: turn.queued.originatingAccountId,
        requesterSenderId: turn.queued.run.senderId,
        requesterSenderName: turn.queued.run.senderName,
        requesterSenderUsername: turn.queued.run.senderUsername,
        requesterSenderE164: turn.queued.run.senderE164,
        threadId: turn.queued.originatingThreadId,
        currentMessageId:
          sameChannelOrigin &&
          (turn.queued.run.inputProvenance?.kind === undefined ||
            turn.queued.run.inputProvenance.kind === "external_user")
            ? turn.queued.messageId
            : undefined,
        cfg: turn.config,
        mirror:
          metadata?.assistantMessageIndex !== undefined ||
          metadata?.assistantTranscriptOwned === true
            ? false
            : mirror,
        replyKind: kind,
        runId,
      });
      if (!result.delivered && (result.queueCustody === "held" || result.ambiguous)) {
        pending = true;
        logVerbose(
          `followup queue: route-reply remains pending: ${result.error ?? "unconfirmed delivery"}`,
        );
        continue;
      }
      if (!result.delivered && !result.suppressed) {
        const routeError = result.error ?? "no visible delivery";
        (dispatcherAvailable ? logVerbose : defaultRuntime.error)?.(
          `followup queue: route-reply failed: ${routeError}`,
        );
        if (sameChannelOrigin && dispatcherAvailable) {
          await dispatchPayload(payload);
        } else if (dispatcherAvailable) {
          crossChannelFailures.push(payload);
        }
      } else if (result.delivered) {
        for (const correlation of turn.queued.deliveryCorrelations ?? []) {
          correlation.onReplyDelivered?.(payload);
        }
        await onObservedReplyDelivery?.();
        if (!result.ok) {
          logVerbose(
            `followup queue: route-reply partially failed after delivery: ${
              result.error ?? "unknown error"
            }`,
          );
        }
        deliveredCrossChannelOrigin ||= crossChannelOrigin;
      }
    }
  }
  // A delivered supplement cannot settle missing terminal content, while a
  // delivered terminal reply does settle failures of later supplements.
  const terminalFailure = crossChannelFailures.some(isReplyPayloadTerminalContent);
  if (
    (terminalFailure || (crossChannelFailures.length > 0 && !deliveredCrossChannelOrigin)) &&
    dispatcherAvailable
  ) {
    await dispatchPayload({
      text:
        "Follow-up completed, but OpenClaw could not deliver it to the originating channel. " +
        "The reply content was not forwarded to this channel to avoid cross-channel misdelivery.",
      isError: true,
    });
  }
  if (kind !== "final" && queuedPayloads.length > 0) {
    await deliverQueuedBatch?.({
      kind: "queued-followup",
      runId,
      originatingChannel,
      payloads: queuedPayloads,
      completion: { kind: "progress" },
    });
  }
  return {
    kind: pending ? ("pending" as const) : ("completed" as const),
    payloads: queuedPayloads,
  };
}
