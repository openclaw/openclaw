import { resolveSendableOutboundReplyParts } from "openclaw/plugin-sdk/reply-payload";
import { sanitizeUserFacingText } from "../../agents/embedded-agent-helpers/sanitize-user-facing-text.js";
import { shouldSuppressLocalExecApprovalPromptAsync } from "../../channels/plugins/exec-approval-local.js";
import { formatPlanChecklistLines } from "../../channels/streaming.js";
import { applyMergePatch } from "../../config/merge-patch.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { logVerbose } from "../../globals.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { createTtsDirectiveTextStreamCleaner } from "../../tts/directives.js";
import { shouldCleanTtsDirectiveText } from "../../tts/tts-config.js";
import { normalizeMessageChannel } from "../../utils/message-channel.js";
import type { GetReplyOptions } from "../get-reply-options.types.js";
import type { ReplyPayload } from "../reply-payload.js";
import { resolveTurnCommentaryProgressOwner } from "./commentary-progress-owner.js";
import type { ChooseDispatchRouteReadyState } from "./dispatch-from-config.choose-route.js";
import {
  hasAskUserPayload,
  hasExecApprovalPayload,
  hasExecApprovalUnavailablePayload,
} from "./dispatch-from-config.payloads.js";
import { loadGetReplyFromConfigRuntime } from "./dispatch-from-config.runtime-loaders.js";
import { withFullRuntimeReplyConfig } from "./get-reply-fast-path.js";
import type { InternalGetReplyFromConfig } from "./get-reply.types.js";
import { waitForReplyDispatcherIdle } from "./reply-dispatcher-idle.js";
import { resolveRunTypingPolicy } from "./typing-policy.js";

export async function prepareDispatchExecution(state: ChooseDispatchRouteReadyState) {
  const {
    cfg,
    ctx,
    isDispatchOperationAborted,
    markInboundDedupeReplayUnsafe,
    markProgress,
    noteCommentaryProgress,
    params,
    sendPayloadAsync,
    sessionKey,
    shouldEmitVerboseProgressAsync,
    shouldRouteToOriginating,
    shouldSendToolSummariesAsync,
    shouldSuppressProgressDelivery,
    turnLedger,
  } = state;
  // When automatic source delivery is suppressed, still let the agent process
  // the inbound message (context, memory, tool calls) but suppress automatic
  // outbound source delivery.
  if (state.suppressDelivery) {
    logVerbose(
      `Delivery suppressed by ${state.deliverySuppressionReason} for session ${state.sessionStoreEntry.sessionKey ?? sessionKey ?? "unknown"} — agent will still process the message`,
    );
  }

  let didSendPlanStatusNotice = false;
  const sendPlanUpdate = async (
    payload: Parameters<NonNullable<GetReplyOptions["onPlanUpdate"]>>[0],
  ): Promise<void> => {
    if (
      (await shouldSuppressProgressDelivery()) ||
      !(await shouldSendToolSummariesAsync()) ||
      didSendPlanStatusNotice ||
      isDispatchOperationAborted()
    ) {
      return;
    }
    didSendPlanStatusNotice = true;
    const explanation = payload.explanation?.replace(/\s+/g, " ").trim();
    const lines = formatPlanChecklistLines(payload.steps ?? [], {
      maxLines: payload.steps?.length ?? 0,
      maxLineChars: 120,
    });
    // Generic notices retain their shipped receipt; prepared notes belong to literal-capable drafts.
    const replyPayload: ReplyPayload = {
      text:
        lines.length > 0
          ? lines.join("\n")
          : payload.explanationFormat === "plain"
            ? "Progress updated"
            : explanation || "Planning next steps.",
      isStatusNotice: true,
    };
    state.assertProgressCurrent();
    if (shouldRouteToOriginating) {
      await sendPayloadAsync(replyPayload);
      return;
    }
    markInboundDedupeReplayUnsafe();
    turnLedger.sendQueued("tool", replyPayload);
  };
  // When block streaming succeeds, there's no final reply, so we need to generate
  // TTS audio separately from the accumulated block content.
  const progressState = {
    accumulatedBlockText: "",
    accumulatedBlockTtsText: "",
    acceptedReplyPayload: false,
    blockCount: 0,
    channelTransformSuppressed: false,
    pendingDirectBlockReplyDelivery: Promise.resolve(),
    progressCallbackStartTail: Promise.resolve(),
  };
  const cleanBlockTtsDirectiveText = shouldCleanTtsDirectiveText({
    cfg,
    preparedTtsPreferences: state.preparedTtsPreferences,
    ttsAuto: state.sessionTtsAuto,
    agentId: state.sessionAgentId,
    channelId: state.deliveryChannel,
    accountId: state.replyRoute.accountId,
  })
    ? createTtsDirectiveTextStreamCleaner()
    : undefined;

  const resolveToolDeliveryPayload = async (
    payload: ReplyPayload,
  ): Promise<ReplyPayload | null> => {
    if (
      await shouldSuppressLocalExecApprovalPromptAsync({
        channel: normalizeMessageChannel(ctx.Surface ?? ctx.Provider),
        cfg,
        accountId: ctx.AccountId,
        payload,
      })
    ) {
      return null;
    }
    if (
      (await shouldSendToolSummariesAsync()) ||
      hasExecApprovalPayload(payload) ||
      hasExecApprovalUnavailablePayload(payload) ||
      hasAskUserPayload(payload)
    ) {
      return payload;
    }
    // Group/native flows intentionally suppress tool summary text, but media-only
    // tool results (for example TTS audio) must still be delivered.
    const hasMedia = resolveSendableOutboundReplyParts(payload).hasMedia;
    if (!hasMedia) {
      return null;
    }
    return { ...payload, text: undefined };
  };
  const typing = resolveRunTypingPolicy({
    requestedPolicy: params.replyOptions?.typingPolicy,
    suppressTyping: state.sourceReplyPolicy.suppressTyping,
    originatingChannel: state.routeReplyChannel,
    systemEvent: shouldRouteToOriginating,
  });
  const onToolResultFromReplyOptions = params.replyOptions?.onToolResult;
  const onPlanUpdateFromReplyOptions = params.replyOptions?.onPlanUpdate;
  const onApprovalEventFromReplyOptions = params.replyOptions?.onApprovalEvent;
  const onPatchSummaryFromReplyOptions = params.replyOptions?.onPatchSummary;
  const allowSuppressedSourceProgressCallbacks =
    params.replyOptions?.allowProgressCallbacksWhenSourceDeliverySuppressed === true;
  const waitForPendingDirectBlockReplyDelivery = (abortSignal?: AbortSignal) =>
    waitForReplyDispatcherIdle(
      { waitForIdle: () => progressState.pendingDirectBlockReplyDelivery },
      abortSignal,
    );
  const shouldForwardProgressCallback = async (options?: {
    allowWhenToolSummariesHidden?: boolean;
    forwardWhenSourceDeliverySuppressed?: boolean;
    requiresToolSummaryVisibility?: boolean;
  }) => {
    if (
      params.replyOptions?.progressRequiresReply === true &&
      state.replyOperationRunState.replyCompletion?.expectation !== "required"
    ) {
      return false;
    }
    if (
      options?.requiresToolSummaryVisibility === true &&
      !(await shouldSendToolSummariesAsync()) &&
      params.replyOptions?.suppressDefaultToolProgressMessages !== true &&
      options.allowWhenToolSummariesHidden !== true
    ) {
      return false;
    }
    return (
      !state.suppressAutomaticSourceDelivery ||
      (allowSuppressedSourceProgressCallbacks &&
        !state.sendPolicyDenied &&
        options?.forwardWhenSourceDeliverySuppressed === true)
    );
  };
  const preserveProgressCallbackStartOrder =
    params.replyOptions?.preserveProgressCallbackStartOrder === true;
  const wrapProgressCallback = <Args extends unknown[], Result extends boolean | void>(
    callback: ((...args: Args) => Promise<Result> | Result) | undefined,
    options?: {
      allowWhenToolSummariesHidden?: boolean;
      forwardWhenSourceDeliverySuppressed?: boolean;
      requiresToolSummaryVisibility?: boolean;
      onForward?: (...args: Args) => Promise<void> | void;
      onVisible?: (...args: Args) => Promise<void> | void;
      waitForDirectBlockReplyDelivery?: boolean;
    },
  ): ((...args: Args) => Promise<Result | undefined>) | undefined => {
    if (!callback) {
      return undefined;
    }
    return async (...args: Args): Promise<Result | undefined> => {
      const start = preserveProgressCallbackStartOrder ? createDeferredCore() : undefined;
      if (start) {
        // Reserve source order synchronously, releasing on invocation rather than completion.
        const previousStart = progressState.progressCallbackStartTail;
        progressState.progressCallbackStartTail = start.promise;
        await previousStart;
      }
      try {
        if (isDispatchOperationAborted()) {
          return undefined;
        }
        state.getDispatchReplyOperation()?.recordActivity();
        markProgress();
        if (options?.waitForDirectBlockReplyDelivery) {
          await waitForPendingDirectBlockReplyDelivery(
            state.getDispatchAbortOperation()?.abortSignal,
          );
          if (isDispatchOperationAborted()) {
            return undefined;
          }
        }
        if ((await shouldForwardProgressCallback(options)) && !isDispatchOperationAborted()) {
          // Preserve the historical microtask boundary for unflagged channels.
          if (!preserveProgressCallbackStartOrder || options?.onForward) {
            await options?.onForward?.(...args);
          }
          if (isDispatchOperationAborted()) {
            return undefined;
          }
          state.assertProgressCurrent();
          const callbackResult = callback(...args);
          start?.resolve();
          const result = await callbackResult;
          if (result === false) {
            return result;
          }
          state.assertProgressCurrent();
          await options?.onVisible?.(...args);
        }
        return undefined;
      } finally {
        start?.resolve();
      }
    };
  };

  const reasoningCallback = params.replyOptions?.onReasoningStream;
  const onReasoningStream = reasoningCallback
    ? wrapProgressCallback(
        (payload: Parameters<NonNullable<GetReplyOptions["onReasoningStream"]>>[0]) => {
          // Preview callbacks bypass queued delivery. Clean the outward snapshot,
          // not provider reasoning or the archived source used for replay.
          const text = sanitizeUserFacingText(payload.text, {
            conversationContext: ctx.BodyForAgent ?? ctx.Body,
            streaming: true,
          });
          const visible = { ...payload, text };
          if (!text.trim() && !resolveSendableOutboundReplyParts(visible).hasMedia) {
            return false;
          }
          return reasoningCallback(visible);
        },
      )
    : undefined;

  // Snapshot verbose progress visibility for this run: commentary
  // classification in the CLI runners is wired once at run start, so a
  // mid-run verbose toggle cannot move inter-tool commentary between lanes.
  const standaloneCommentaryProgressVisible = await shouldEmitVerboseProgressAsync();
  state.assertProgressCurrent();
  // GetReplyOptions still publishes a synchronous visibility callback to released plugins.
  const resolveVerboseProgressVisibility = () =>
    standaloneCommentaryProgressVisible &&
    state.shouldSendToolSummaries() &&
    !state.shouldSuppressProgressDeliverySync();
  const { commentaryPayloadsEnabled, draftOwnsCommentaryProgress } =
    await resolveTurnCommentaryProgressOwner({
      commentaryPayloadsEnabled: state.commentaryPayloadsEnabled,
      options: params.replyOptions,
      resolveVerboseProgressVisibility,
      resolveVerboseProgressVisibilityAsync: async () => {
        const visible =
          standaloneCommentaryProgressVisible &&
          (await state.shouldSendToolSummariesAsync()) &&
          !(await state.shouldSuppressProgressDelivery());
        state.assertProgressCurrent();
        return visible;
      },
    });
  state.assertProgressCurrent();
  const deliverStandaloneCommentaryProgress =
    standaloneCommentaryProgressVisible && !draftOwnsCommentaryProgress;
  const canForwardItemEvents = Boolean(params.replyOptions?.onItemEvent);
  const canForwardSuppressedSourceItemEvents =
    allowSuppressedSourceProgressCallbacks && !state.sendPolicyDenied && canForwardItemEvents;
  const shouldDeliverDurableCommentaryProgress = (
    payload: Parameters<NonNullable<GetReplyOptions["onItemEvent"]>>[0],
  ) =>
    deliverStandaloneCommentaryProgress &&
    payload.kind === "preamble" &&
    payload.suppressDurableProgress !== true;
  const forwardItemEvent = wrapProgressCallback(params.replyOptions?.onItemEvent, {
    forwardWhenSourceDeliverySuppressed: true,
    requiresToolSummaryVisibility: true,
    waitForDirectBlockReplyDelivery: true,
    onForward: (payload) =>
      preserveProgressCallbackStartOrder && shouldDeliverDurableCommentaryProgress(payload)
        ? noteCommentaryProgress(payload)
        : undefined,
  });
  // CLI runners classify preambles as item events only when this handler exists.
  // Keep it for channel-owned capture even when delivery policy hides the event.
  const onItemEvent =
    deliverStandaloneCommentaryProgress || canForwardItemEvents
      ? async (payload: Parameters<NonNullable<GetReplyOptions["onItemEvent"]>>[0]) => {
          if (isDispatchOperationAborted()) {
            return;
          }
          if (!forwardItemEvent && deliverStandaloneCommentaryProgress) {
            // The wrapped forwarder marks progress itself when present.
            markProgress();
          }
          if (
            (!forwardItemEvent || !preserveProgressCallbackStartOrder) &&
            shouldDeliverDurableCommentaryProgress(payload)
          ) {
            await noteCommentaryProgress(payload);
          }
          return await forwardItemEvent?.(payload);
        }
      : undefined;
  const replyResolver: InternalGetReplyFromConfig =
    params.replyResolver ??
    (
      await state.traceReplyPhase("reply.load_reply_resolver", () =>
        loadGetReplyFromConfigRuntime(),
      )
    ).getReplyFromConfig;
  const runtimeReplyConfig = state.preparedReplyDispatchRuntime?.config ?? cfg;
  const replyConfig = withFullRuntimeReplyConfig(
    params.configOverride
      ? (applyMergePatch(runtimeReplyConfig, params.configOverride) as OpenClawConfig)
      : runtimeReplyConfig,
  );
  state.recordAgentDispatchStarted();
  return Object.assign(state, {
    sendPlanUpdate,
    cleanBlockTtsDirectiveText,
    resolveToolDeliveryPayload,
    typing,
    onToolResultFromReplyOptions,
    onPlanUpdateFromReplyOptions,
    onApprovalEventFromReplyOptions,
    onPatchSummaryFromReplyOptions,
    waitForPendingDirectBlockReplyDelivery,
    shouldForwardProgressCallback,
    preserveProgressCallbackStartOrder,
    wrapProgressCallback,
    onReasoningStream,
    deliverStandaloneCommentaryProgress,
    canForwardSuppressedSourceItemEvents,
    onItemEvent,
    commentaryPayloadsEnabled,
    replyResolver,
    replyConfig,
    progressState,
  });
}

export type PrepareDispatchExecutionReadyState = Awaited<
  ReturnType<typeof prepareDispatchExecution>
>;
