import type { GetReplyOptions } from "../auto-reply/types.js";

type ReplyActivityOnEvent = (event: ReplyActivityEvent) => Promise<void> | void;

type ToolStartPayload = Parameters<NonNullable<GetReplyOptions["onToolStart"]>>[0];
type ItemEventPayload = Parameters<NonNullable<GetReplyOptions["onItemEvent"]>>[0];
type PlanUpdatePayload = Parameters<NonNullable<GetReplyOptions["onPlanUpdate"]>>[0];
type ApprovalEventPayload = Parameters<NonNullable<GetReplyOptions["onApprovalEvent"]>>[0];
type CommandOutputPayload = Parameters<NonNullable<GetReplyOptions["onCommandOutput"]>>[0];
type PatchSummaryPayload = Parameters<NonNullable<GetReplyOptions["onPatchSummary"]>>[0];
type PartialReplyPayload = Parameters<NonNullable<GetReplyOptions["onPartialReply"]>>[0];
type ReasoningPayload = Parameters<NonNullable<GetReplyOptions["onReasoningStream"]>>[0];

export type ReplyActivityEvent =
  | { type: "agent_run_start"; payload: { runId: string } }
  | { type: "assistant_message_start" }
  | { type: "partial_reply"; payload: PartialReplyPayload }
  | { type: "reasoning"; payload: ReasoningPayload }
  | { type: "reasoning_end" }
  | { type: "tool_start"; payload: ToolStartPayload }
  | { type: "item"; payload: ItemEventPayload }
  | { type: "plan_update"; payload: PlanUpdatePayload }
  | { type: "approval"; payload: ApprovalEventPayload }
  | { type: "command_output"; payload: CommandOutputPayload }
  | { type: "patch_summary"; payload: PatchSummaryPayload }
  | { type: "compaction_start" }
  | { type: "compaction_end" };

export type ReplyActivityCallbacks = Pick<
  GetReplyOptions,
  | "onAgentRunStart"
  | "onAssistantMessageStart"
  | "onPartialReply"
  | "onReasoningStream"
  | "onReasoningEnd"
  | "onToolStart"
  | "onItemEvent"
  | "onPlanUpdate"
  | "onApprovalEvent"
  | "onCommandOutput"
  | "onPatchSummary"
  | "onCompactionStart"
  | "onCompactionEnd"
>;

export type CreateReplyActivityCallbacksOptions = {
  /**
   * Receive normalized live activity emitted directly from the reply execution
   * path. This avoids relying on the global agent-event bus for channel-local
   * UI/status updates.
   */
  onEvent: ReplyActivityOnEvent;
  /**
   * Text deltas are opt-in so plugins can keep existing partial-reply handling
   * without accidentally duplicating outbound text on their activity stream.
   */
  includePartialReplies?: boolean;
};

function emitNoPayload(
  onEvent: ReplyActivityOnEvent,
  type: "assistant_message_start" | "reasoning_end" | "compaction_start" | "compaction_end",
): Promise<void> | void {
  return onEvent({ type });
}

function emit(onEvent: ReplyActivityOnEvent, event: ReplyActivityEvent): Promise<void> | void {
  return onEvent(event);
}

export function createReplyActivityCallbacks(
  params: CreateReplyActivityCallbacksOptions,
): ReplyActivityCallbacks {
  return {
    onAgentRunStart: (runId) =>
      emit(params.onEvent, {
        type: "agent_run_start",
        payload: { runId },
      }),
    onAssistantMessageStart: () => emitNoPayload(params.onEvent, "assistant_message_start"),
    onPartialReply: params.includePartialReplies
      ? (payload) => emit(params.onEvent, { type: "partial_reply", payload })
      : undefined,
    onReasoningStream: (payload) => emit(params.onEvent, { type: "reasoning", payload }),
    onReasoningEnd: () => emitNoPayload(params.onEvent, "reasoning_end"),
    onToolStart: (payload) => emit(params.onEvent, { type: "tool_start", payload }),
    onItemEvent: (payload) => emit(params.onEvent, { type: "item", payload }),
    onPlanUpdate: (payload) => emit(params.onEvent, { type: "plan_update", payload }),
    onApprovalEvent: (payload) => emit(params.onEvent, { type: "approval", payload }),
    onCommandOutput: (payload) => emit(params.onEvent, { type: "command_output", payload }),
    onPatchSummary: (payload) => emit(params.onEvent, { type: "patch_summary", payload }),
    onCompactionStart: () => emitNoPayload(params.onEvent, "compaction_start"),
    onCompactionEnd: () => emitNoPayload(params.onEvent, "compaction_end"),
  };
}
