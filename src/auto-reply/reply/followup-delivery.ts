/** Prepares queued follow-up payloads for source-channel delivery. */
import { hasOutboundReplyContent } from "openclaw/plugin-sdk/reply-payload";
import {
  hasCommittedSourceReplyDeliveryEvidence,
  hasCompletedSourceReplyDeliveryEvidence,
  resolveExplicitFinalSourceReplyDeliveryEvidence,
  resolveSourceReplyDelivery,
  hasVisibleCommittedMessagingToolDeliveryEvidence,
} from "../../agents/embedded-agent-runner/delivery-evidence.js";
import {
  isSyntheticSourceReplyTurn,
  resolveReplyCompletion,
} from "../../agents/reply-completion.js";
import { buildAgentRuntimeDeliveryPlan } from "../../agents/runtime-plan/build.js";
import { logVerbose } from "../../globals.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { defaultRuntime } from "../../runtime.js";
import { sessionDeliveryChannel } from "../../utils/delivery-context.read.js";
import { isInternalMessageChannel } from "../../utils/message-channel.js";
import {
  getReplyPayloadMetadata,
  isReplyPayloadTerminalContent,
  markReplyPayloadForSourceSuppressionDelivery,
  setReplyPayloadMetadata,
} from "../reply-payload.js";
import type { ReplyPayload } from "../types.js";
import {
  normalizeAssistantFinalDeliveryText,
  resolveTerminalReplyDelivery,
} from "./agent-runner-core.js";
import type { AgentTurnExecutionResult } from "./agent-runner-execution.types.js";
import {
  buildEmptyInteractiveReplyPayload,
  markPostCompactionModelFailurePayload,
  renderPostCompactionModelFailurePayload,
} from "./agent-runner-failure-reply.js";
import type { AccountedAgentTurn } from "./agent-runner-result-accounting.js";
import { appendUsageLine, resolveResponseUsageLine } from "./agent-runner-usage-line.js";
import { resolveFollowupDeliveryPayloads } from "./followup-delivery-payloads.js";
import type { AdmittedFollowupTurn, FollowupRunnerParams } from "./followup-turn-admission.js";
import type { InternalGetReplyOptions } from "./get-reply.types.js";
import { resolveOriginMessageProvider } from "./origin-routing.js";
import { warnPrivateMessageToolFinal } from "./private-message-tool-final.js";
import { enqueueFollowupRun, resolveQueueSettings, type FollowupRun } from "./queue.js";
import type { ReplyDispatchKind } from "./reply-dispatcher.types.js";
import { isRoutableChannel, routeReply } from "./route-reply.js";
import {
  resolveSourceReplyExpectation,
  resolveSourceReplyVisibilityPolicy,
} from "./source-reply-delivery-mode.js";
import {
  buildStrandedReplyDeliveryFailurePayload,
  resolveStrandedReplyRecovery,
} from "./stranded-reply-recovery.js";
import { createTypingSignaler } from "./typing-mode.js";
import { buildWaitingStatusPayload } from "./waiting-status.js";

type FollowupDeliveryDecision =
  | {
      kind: "deliver";
      payloads: ReplyPayload[];
      resolved?: { provider: string; model: string };
    }
  | {
      kind: "suppress";
      reason: "send-policy" | "room-event" | "silent" | "message-tool-only" | "aborted";
    }
  | {
      kind: "retry-source-delivery";
      run: FollowupRun;
      finalTextLength: number;
      resolved: { provider: string; model: string };
    }
  | {
      kind: "deliver-diagnostic";
      payload: ReplyPayload;
      resolved: { provider: string; model: string };
    };

/** Resolves one final queued delivery action without performing transport I/O. */
export async function resolveFollowupDeliveryDecision(params: {
  turn: AdmittedFollowupTurn;
  execution: AgentTurnExecutionResult;
  accounting?: AccountedAgentTurn & {
    compactionNotice?: ReplyPayload;
    diagnosticsPayload?: ReplyPayload;
  };
  opts?: InternalGetReplyOptions;
}): Promise<FollowupDeliveryDecision> {
  const { turn, execution, accounting, opts } = params;
  if (turn.sendPolicy === "deny") {
    return { kind: "suppress", reason: "send-policy" };
  }
  if (
    turn.queued.currentInboundEventKind === "room_event" &&
    !isInternalMessageChannel(turn.queued.originatingChannel)
  ) {
    return { kind: "suppress", reason: "room-event" };
  }
  if (execution.outcome.kind === "aborted") {
    return { kind: "suppress", reason: "aborted" };
  }
  const postCompactionModelFailure = execution.outcome.postCompactionModelFailure;
  const renderFailurePayloads = (payloads: ReplyPayload[]) =>
    payloads.map((payload) =>
      renderPostCompactionModelFailurePayload(
        markPostCompactionModelFailurePayload(postCompactionModelFailure, payload),
      ),
    );
  const sourcePolicy = resolveSourceReplyVisibilityPolicy({
    cfg: turn.config,
    ctx: {
      ChatType: turn.queued.originatingChatType ?? turn.queued.run.chatType,
      InboundEventKind: turn.queued.currentInboundEventKind,
      Provider: turn.queued.originatingChannel ?? turn.queued.run.messageProvider,
      Surface: turn.queued.originatingChannel ?? turn.queued.run.messageProvider,
    },
    requested: turn.queued.run.sourceReplyDeliveryMode ?? opts?.sourceReplyDeliveryMode,
    sendPolicy: turn.sendPolicy,
  });
  const terminalReplyExpectation =
    turn.queued.run.terminalReplyExpectation ??
    resolveSourceReplyExpectation({
      ctx: {
        InboundEventKind: turn.queued.currentInboundEventKind,
        InputProvenance: turn.queued.run.inputProvenance,
      },
      cfg: turn.config,
    });
  const isInteractive =
    terminalReplyExpectation === "required" ||
    (!isSyntheticSourceReplyTurn({ inputProvenance: turn.queued.run.inputProvenance }) &&
      !isInternalMessageChannel(
        turn.queued.originatingChannel ?? turn.queued.run.messageProvider,
      ) &&
      Boolean(
        turn.queued.originatingTo?.trim() ||
        opts?.onBlockReply ||
        turn.queued.queuedFollowupReplyDisposition?.kind === "deliver",
      ));
  const deliveryContext = {
    cfg: turn.config,
    messageProvider: turn.queued.run.messageProvider,
    originatingAccountId: turn.queued.originatingAccountId ?? turn.queued.run.agentAccountId,
    originatingChannel: turn.queued.originatingChannel,
    originatingChatType: turn.queued.originatingChatType,
    originatingReplyToMode: turn.queued.originatingReplyToMode,
    originatingTo: turn.queued.originatingTo,
    originatingThreadId: turn.queued.originatingThreadId,
  };
  if (execution.outcome.kind === "rejected") {
    if (!isInteractive) {
      return { kind: "suppress", reason: "silent" };
    }
    if (
      sourcePolicy.sourceReplyDeliveryMode === "message_tool_only" &&
      getReplyPayloadMetadata(execution.outcome.payload)?.deliverDespiteSourceReplySuppression !==
        true
    ) {
      return { kind: "suppress", reason: "message-tool-only" };
    }
    const payloads = renderFailurePayloads(
      resolveFollowupDeliveryPayloads({
        ...deliveryContext,
        payloads: [execution.outcome.payload],
        reasoningPayloadsEnabled: opts?.reasoningPayloadsEnabled === true,
        commentaryPayloadsEnabled: opts?.commentaryPayloadsEnabled === true,
      }),
    );
    return payloads.length > 0
      ? {
          kind: "deliver",
          payloads,
          resolved: execution.outcome.resolved,
        }
      : { kind: "suppress", reason: "silent" };
  }
  if (!accounting) {
    return { kind: "suppress", reason: "silent" };
  }
  const runtimeResolved = {
    provider: accounting.providerUsed,
    model: accounting.modelUsed,
  };
  const result = execution.outcome.result;
  const pendingContinuation =
    result.meta?.yielded === true ||
    result.meta?.continuationPending === true ||
    (result.meta?.pendingToolCalls?.length ?? 0) > 0;
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
    terminalReplyExpectation,
    result.meta?.error?.kind === "hook_block" || result.didSendDeterministicApprovalPrompt === true
      ? "blocked"
      : sourceReplyDelivery !== "missing"
        ? sourceReplyDelivery
        : pendingContinuation
          ? "pending"
          : "empty",
  );
  const completedSourceDelivery = hasCompletedSourceReplyDeliveryEvidence(result);
  const hasLegacyMessagingToolEvidence =
    result.sourceReplyDeliveryState === undefined &&
    resolveExplicitFinalSourceReplyDeliveryEvidence(result) === undefined;
  const assistantFinalText = normalizeAssistantFinalDeliveryText(
    typeof result.meta?.finalAssistantVisibleText === "string"
      ? result.meta.finalAssistantVisibleText
      : "",
  );
  let payloads = resolveFollowupDeliveryPayloads({
    ...deliveryContext,
    payloads: accounting.payloadArray,
    reasoningPayloadsEnabled: opts?.reasoningPayloadsEnabled === true,
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
    accounting.terminalFailurePayload || completion.outcome !== "missing"
      ? ({ kind: "none" } as const)
      : resolveStrandedReplyRecovery({
          base: turn.queued,
          payloads,
          finalText: assistantFinalText,
          sourceReplyDeliveryMode: sourcePolicy.sourceReplyDeliveryMode,
          sendPolicyDenied: sourcePolicy.sendPolicyDenied,
          successfulSourceReplyDelivery: completedSourceDelivery,
          isHeartbeat: false,
          isRoomEvent: false,
        });
  if (recovery.kind === "retry") {
    return {
      kind: "retry-source-delivery",
      run: recovery.run,
      finalTextLength: assistantFinalText.trim().length,
      resolved: runtimeResolved,
    };
  }
  if (recovery.kind === "diagnostic") {
    const [payload] = resolveFollowupDeliveryPayloads({
      ...deliveryContext,
      payloads: [recovery.payload],
    });
    if (!payload) {
      return { kind: "suppress", reason: "silent" };
    }
    return {
      kind: "deliver-diagnostic",
      payload,
      resolved: runtimeResolved,
    };
  }
  const hasTerminalPayload = payloads.some(
    (payload) =>
      isReplyPayloadTerminalContent(payload) &&
      // Private terminal content is not an empty result. Source visibility is
      // enforced below; genuine failures and yield acknowledgments still win.
      ((!accounting.terminalFailurePayload && !pendingContinuation) ||
        sourcePolicy.sourceReplyDeliveryMode !== "message_tool_only" ||
        getReplyPayloadMetadata(payload)?.deliverDespiteSourceReplySuppression === true),
  );
  const waitingStatusParams = {
    completion,
    continuationPending: result.meta?.continuationPending === true,
    yielded: result.meta?.yielded === true,
    yieldAcknowledgment: result.meta?.yieldAcknowledgment,
    // Child spawns are side effects, not user-visible messages. They must not
    // suppress the explicit waiting reply for the parent turn.
    hasVisibleMessageDelivery:
      hasCommittedSourceReplyDeliveryEvidence(result) ||
      hasVisibleCommittedMessagingToolDeliveryEvidence(result) ||
      result.didSendDeterministicApprovalPrompt === true,
  };
  const waitingStatusPayload = accounting.terminalFailurePayload
    ? undefined
    : buildWaitingStatusPayload(waitingStatusParams);
  const fallbackPayload = accounting.terminalFailurePayload
    ? isInteractive &&
      completion.outcome !== "delivered" &&
      completion.outcome !== "pending" &&
      completion.outcome !== "blocked"
      ? sourcePolicy.sourceReplyDeliveryMode === "message_tool_only"
        ? markReplyPayloadForSourceSuppressionDelivery(accounting.terminalFailurePayload)
        : accounting.terminalFailurePayload
      : undefined
    : (waitingStatusPayload ?? buildEmptyInteractiveReplyPayload({ completion }));
  if (!hasTerminalPayload && fallbackPayload) {
    payloads = [
      ...payloads,
      ...resolveFollowupDeliveryPayloads({
        ...deliveryContext,
        payloads: [fallbackPayload],
      }),
    ];
  }
  if (accounting.compactionNotice) {
    const compactionNotices = resolveFollowupDeliveryPayloads({
      ...deliveryContext,
      payloads: [accounting.compactionNotice],
    });
    payloads = [...compactionNotices, ...payloads];
  }
  if (accounting.diagnosticsPayload && payloads.length > 0) {
    payloads = [
      ...payloads,
      ...resolveFollowupDeliveryPayloads({
        ...deliveryContext,
        payloads: [accounting.diagnosticsPayload],
      }),
    ];
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
  if (responseUsageLine) {
    payloads = appendUsageLine(payloads, responseUsageLine);
  }
  payloads = renderFailurePayloads(payloads);
  if (sourcePolicy.sourceReplyDeliveryMode === "message_tool_only") {
    payloads = payloads.filter(
      (payload) => getReplyPayloadMetadata(payload)?.deliverDespiteSourceReplySuppression === true,
    );
    if (payloads.length === 0) {
      return { kind: "suppress", reason: "message-tool-only" };
    }
  }
  if (result.meta?.yielded === true && result.acceptedSessionSpawns?.length) {
    const statusPayload = payloads.find(
      (payload) => getReplyPayloadMetadata(payload)?.continuationStatus === true,
    );
    const requesterSessionKey =
      turn.session.kind === "session" ? turn.session.key : turn.queued.run.sessionKey;
    if (statusPayload && requesterSessionKey) {
      // Only accepted waiting replies need the task presentation runtime.
      const { createTaskProgressContinuation } =
        await import("../../tasks/task-progress-requester.js");
      const progressContinuation = await createTaskProgressContinuation({
        requesterSessionKey,
        requesterAgentId: turn.queued.run.agentId,
        requesterTurnRunId: execution.runId,
        acceptedSessionSpawns: result.acceptedSessionSpawns,
      });
      if (progressContinuation) {
        setReplyPayloadMetadata(statusPayload, { progressContinuation });
      }
    }
  }
  return payloads.length > 0
    ? { kind: "deliver", payloads, resolved: runtimeResolved }
    : { kind: "suppress", reason: "silent" };
}

async function sendFollowupPayloads(params: {
  payloads: ReplyPayload[];
  turn: AdmittedFollowupTurn;
  defaults: FollowupRunnerParams;
  runId: string;
  kind: ReplyDispatchKind;
  mirror?: boolean;
  resolved?: { provider: string; model: string };
}): Promise<ReplyPayload[]> {
  const { turn, defaults } = params;
  const { originatingChannel, originatingTo } = turn.queued;
  const originRoutable = Boolean(isRoutableChannel(originatingChannel) && originatingTo);
  const deliveryPlan = buildAgentRuntimeDeliveryPlan({
    provider: params.resolved?.provider ?? turn.queued.run.provider,
    modelId: params.resolved?.model ?? turn.queued.run.model,
    config: turn.config,
    workspaceDir: turn.queued.run.workspaceDir,
    agentDir: turn.queued.run.agentDir,
  });
  const payloads = params.payloads.filter(
    (payload) =>
      hasOutboundReplyContent(payload) &&
      (!deliveryPlan.isSilentPayload(payload) ||
        getReplyPayloadMetadata(payload)?.deliverDespiteSourceReplySuppression === true),
  );
  if (payloads.length === 0) {
    return [];
  }
  const sourceDisposition = turn.queued.queuedFollowupReplyDisposition;
  if (sourceDisposition?.kind === "drop") {
    logVerbose(`followup queue: source delivery dropped (${sourceDisposition.reason})`);
    return [];
  }
  const deliverQueuedBatch = sourceDisposition?.deliver;
  const fallbackDispatcher = sourceDisposition ? undefined : defaults.opts?.onBlockReply;
  const dispatcherAvailable = Boolean(deliverQueuedBatch || fallbackDispatcher);
  if (!originRoutable && !dispatcherAvailable) {
    defaultRuntime.error?.(
      "followup queue: completed with payloads but no origin route or visible dispatcher is available",
    );
    return [];
  }
  const typing = createTypingSignaler({
    typing: defaults.typing,
    mode: defaults.typingMode,
    isHeartbeat: false,
  });
  const crossChannelFailures: ReplyPayload[] = [];
  const queuedPayloads: ReplyPayload[] = [];
  const dispatchPayload = async (payload: ReplyPayload) => {
    if (deliverQueuedBatch) {
      queuedPayloads.push(payload);
    } else {
      await fallbackDispatcher?.(payload);
    }
  };
  let deliveredCrossChannelOrigin = false;
  let deliveredOriginFinal = false;
  const provider = resolveOriginMessageProvider({
    provider: turn.queued.run.messageProvider,
  });
  const origin = resolveOriginMessageProvider({ originatingChannel });
  const sameChannelOrigin = Boolean(origin && origin === provider);
  const crossChannelOrigin = Boolean(origin && provider && origin !== provider);
  for (const payload of payloads) {
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
    await typing.signalTextDelta(payload.text);
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
            : params.mirror,
        replyKind: params.kind,
        runId: params.runId,
      });
      if (!result.delivered && (result.queueCustody === "held" || result.ambiguous)) {
        logVerbose(
          `followup queue: route-reply remains pending: ${result.error ?? "unconfirmed delivery"}`,
        );
        continue;
      }
      if (!result.delivered && !result.suppressed) {
        const routeError = result.error ?? "no visible delivery";
        logVerbose(`followup queue: route-reply failed: ${routeError}`);
        if (sameChannelOrigin && dispatcherAvailable) {
          await dispatchPayload(payload);
        } else if (dispatcherAvailable) {
          crossChannelFailures.push(payload);
        } else {
          defaultRuntime.error?.(`followup queue: route-reply failed: ${routeError}`);
        }
      } else if (result.delivered) {
        if (!result.ok) {
          logVerbose(
            `followup queue: route-reply partially failed after delivery: ${
              result.error ?? "unknown error"
            }`,
          );
        }
        deliveredCrossChannelOrigin ||= crossChannelOrigin;
        deliveredOriginFinal ||= params.kind === "final" && isReplyPayloadTerminalContent(payload);
      }
    }
  }
  if (deliveredOriginFinal) {
    // Origin delivery bypasses the source channel's own final-reply path, so
    // its progress UI only learns about a confirmed final through this hook.
    try {
      await defaults.opts?.onQueuedFollowupFinalDelivered?.();
    } catch (error) {
      defaultRuntime.error?.(
        `followup queue: queued final delivery cleanup failed: ${formatErrorMessage(error)}`,
      );
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
  if (params.kind !== "final" && queuedPayloads.length > 0) {
    await deliverQueuedBatch?.({
      kind: "queued-followup",
      runId: params.runId,
      originatingChannel,
      payloads: queuedPayloads,
      completion: { kind: "progress" },
    });
  }
  return queuedPayloads;
}

/** Performs the already-resolved follow-up delivery action. */
export type FollowupDeliveryResult =
  | { kind: "completed"; payloads: ReplyPayload[] }
  | { kind: "source-retry" };

export async function deliverFollowupDecision(params: {
  decision: FollowupDeliveryDecision;
  turn: AdmittedFollowupTurn;
  defaults: FollowupRunnerParams;
  runId: string;
  runFollowup: (run: FollowupRun) => Promise<void>;
  kind?: ReplyDispatchKind;
}): Promise<FollowupDeliveryResult> {
  const { decision, turn, defaults } = params;
  if (decision.kind === "suppress") {
    logVerbose(`followup queue: delivery suppressed (${decision.reason})`);
    return { kind: "completed", payloads: [] };
  }
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
    const sourceDisposition = turn.queued.queuedFollowupReplyDisposition;
    const retryDelivery =
      sourceDisposition?.kind === "deliver"
        ? sourceDisposition.deliver.createSourceRetry?.()
        : undefined;
    const retryRun = retryDelivery
      ? {
          ...decision.run,
          queuedFollowupReplyDisposition: { kind: "deliver" as const, deliver: retryDelivery },
        }
      : decision.run;
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
        { position: "front" },
      );
    if (enqueued) {
      return { kind: "source-retry" };
    }
    const diagnosticPayloads = resolveFollowupDeliveryPayloads({
      cfg: turn.config,
      payloads: [buildStrandedReplyDeliveryFailurePayload()],
      messageProvider: turn.queued.run.messageProvider,
      originatingAccountId: turn.queued.originatingAccountId ?? turn.queued.run.agentAccountId,
      originatingChannel: turn.queued.originatingChannel,
      originatingChatType: turn.queued.originatingChatType,
      originatingReplyToMode: turn.queued.originatingReplyToMode,
      originatingTo: turn.queued.originatingTo,
      originatingThreadId: turn.queued.originatingThreadId,
    });
    const payloads = await sendFollowupPayloads({
      payloads: diagnosticPayloads,
      turn,
      defaults,
      runId: params.runId,
      kind: params.kind ?? "final",
      resolved: decision.resolved,
    });
    return { kind: "completed", payloads };
  }
  const payloads = await sendFollowupPayloads({
    payloads: decision.kind === "deliver" ? decision.payloads : [decision.payload],
    turn,
    defaults,
    runId: params.runId,
    kind: params.kind ?? "final",
    mirror: params.kind && params.kind !== "final" ? false : undefined,
    resolved: decision.resolved,
  });
  return { kind: "completed", payloads };
}
