import type { FollowupRunnerParams } from "./followup-turn-admission.js";

/** Retain only source-owned presentation, never the runner's execution or authority context. */
export function captureQueuedReplyPresentation(
  source: Pick<FollowupRunnerParams, "opts" | "typing" | "typingMode" | "toolProgressDetail">,
) {
  const opts = source.opts;
  return {
    typing: source.typing,
    typingMode: source.typingMode,
    toolProgressDetail: source.toolProgressDetail,
    // Materialize missing callbacks too: an intentionally quiet source must not
    // inherit another thread's callbacks when this presentation replaces defaults.
    opts: {
      onReplyStart: opts?.onReplyStart,
      onTypingCleanup: opts?.onTypingCleanup,
      onTypingController: opts?.onTypingController,
      typingKeepalive: opts?.typingKeepalive,
      typingPolicy: opts?.typingPolicy,
      suppressTyping: opts?.suppressTyping,
      suppressDefaultToolProgressMessages: opts?.suppressDefaultToolProgressMessages,
      suppressToolProgressMessages: opts?.suppressToolProgressMessages,
      allowToolLifecycleWhenProgressHidden: opts?.allowToolLifecycleWhenProgressHidden,
      allowProgressCallbacksWhenSourceDeliverySuppressed:
        opts?.allowProgressCallbacksWhenSourceDeliverySuppressed,
      onVerboseProgressVisibility: opts?.onVerboseProgressVisibility,
      preserveProgressCallbackStartOrder: opts?.preserveProgressCallbackStartOrder,
      onPartialReply: opts?.onPartialReply,
      onReasoningStream: opts?.onReasoningStream,
      onReasoningProgress: opts?.onReasoningProgress,
      streamReasoningInNonStreamModes: opts?.streamReasoningInNonStreamModes,
      onReasoningEnd: opts?.onReasoningEnd,
      onAssistantMessageStart: opts?.onAssistantMessageStart,
      onToolResult: opts?.onToolResult,
      onToolStart: opts?.onToolStart,
      onItemEvent: opts?.onItemEvent,
      onNarrationUpdate: opts?.onNarrationUpdate,
      onProgressNarratorLifecycle: opts?.onProgressNarratorLifecycle,
      isProgressDraftVisible: opts?.isProgressDraftVisible,
      narrationHideCommandText: opts?.narrationHideCommandText,
      commentaryProgressEnabled: opts?.commentaryProgressEnabled,
      progressPreambleEnabled: opts?.progressPreambleEnabled,
      reasoningPayloadsEnabled: opts?.reasoningPayloadsEnabled,
      commentaryPayloadsEnabled: opts?.commentaryPayloadsEnabled,
      shouldDeliverCommentaryPayloads: opts?.shouldDeliverCommentaryPayloads,
      onPlanUpdate: opts?.onPlanUpdate,
      onApprovalEvent: opts?.onApprovalEvent,
      onCommandOutput: opts?.onCommandOutput,
      onPatchSummary: opts?.onPatchSummary,
      onCompactionStart: opts?.onCompactionStart,
      onCompactionEnd: opts?.onCompactionEnd,
      onModelSelected: opts?.onModelSelected,
      onQueuedFollowupAdmitted: opts?.onQueuedFollowupAdmitted,
      onQueuedFollowupSettled: opts?.onQueuedFollowupSettled,
      onObservedReplyDelivery: opts?.onObservedReplyDelivery,
      forceToolResultProgress: opts?.forceToolResultProgress,
    },
  };
}

export type QueuedReplyPresentation = ReturnType<typeof captureQueuedReplyPresentation>;

export function applyQueuedReplyPresentation(
  defaults: FollowupRunnerParams,
  presentation: QueuedReplyPresentation | undefined,
): FollowupRunnerParams {
  if (!presentation) {
    return defaults;
  }
  return {
    ...defaults,
    ...presentation,
    opts: { ...defaults.opts, ...presentation.opts },
  };
}
