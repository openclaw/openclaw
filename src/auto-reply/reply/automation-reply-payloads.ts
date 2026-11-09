import { hasOutboundReplyContent } from "openclaw/plugin-sdk/reply-payload";
import { resolveExplicitFinalSourceReplyDeliveryEvidence } from "../../agents/embedded-agent-runner/delivery-evidence.js";
import type { ReplyCompletion } from "../../agents/reply-completion.js";
import { hasPendingAutomationContinuation } from "../../cron/automation-result.js";
import { isHostNoticePayload, isReplyPayloadTerminalContent } from "../reply-payload.js";
import type { ReplyPayload } from "../types.js";
import type { SettledAgentTurn } from "./agent-runner-execution.types.js";
import type { InternalGetReplyOptions } from "./get-reply.types.js";

/** Shared terminal facts keep foreground and queued automation delivery in agreement. */
export function resolveAutomationReplyState(
  execution: SettledAgentTurn,
  params: {
    opts?: InternalGetReplyOptions;
    terminalFailurePayload?: ReplyPayload;
  } = {},
) {
  const { opts, terminalFailurePayload = execution.terminalFailurePayload } = params;
  const result = execution.result;
  const blocked =
    result.meta?.error?.kind === "hook_block" || result.didSendDeterministicApprovalPrompt === true;
  const successfulTerminal =
    execution.status === "ok" &&
    !blocked &&
    !result.meta?.error &&
    result.meta?.aborted !== true &&
    !terminalFailurePayload;
  const authoredSilence =
    successfulTerminal && result.meta?.terminalReply?.disposition === "silent";
  const pendingContinuation = hasPendingAutomationContinuation(result.meta);
  const automationNoChange =
    successfulTerminal &&
    !pendingContinuation &&
    execution.automation?.result?.outcome === "no_change";
  const reasoningPayloadsEnabled = execution.automation
    ? execution.automation.includeReasoning &&
      successfulTerminal &&
      !pendingContinuation &&
      !authoredSilence &&
      !automationNoChange
    : opts?.reasoningPayloadsEnabled === true;
  return {
    blocked,
    successfulTerminal,
    authoredSilence,
    pendingContinuation,
    automationNoChange,
    reasoningPayloadsEnabled,
  };
}

/** Reasoning can accompany an automation's deliverable result, never replace it. */
export function retainAutomationReasoningWithFinal(payloads: ReplyPayload[]): ReplyPayload[] {
  return !payloads.some((payload) => payload.isError) &&
    payloads.some(
      (payload) =>
        isReplyPayloadTerminalContent(payload) &&
        !isHostNoticePayload(payload) &&
        hasOutboundReplyContent(payload),
    )
    ? payloads
    : payloads.filter((payload) => payload.isReasoning !== true);
}

/** Call only after route and content dedupe confirms an already delivered final. */
export function canCompleteMessagingToolDuplicate(params: {
  result: SettledAgentTurn["result"];
  completion: ReplyCompletion;
  successfulTerminal: boolean;
  pendingContinuation: boolean;
  sourceReplyDeliveryMode: InternalGetReplyOptions["sourceReplyDeliveryMode"];
}): boolean {
  const { result, completion, successfulTerminal, pendingContinuation, sourceReplyDeliveryMode } =
    params;
  if (["blocked", "pending", "silent"].includes(completion.outcome)) {
    return false;
  }
  // A successful automatic final can confirm an earlier send. "missing" means
  // the runtime has not observed a terminal reply; it does not retain custody.
  const canConfirmEarlierSend =
    successfulTerminal && !pendingContinuation && sourceReplyDeliveryMode !== "message_tool_only";
  return (
    (result.sourceReplyDeliveryState === undefined ||
      (result.sourceReplyDeliveryState === "missing" && canConfirmEarlierSend)) &&
    (resolveExplicitFinalSourceReplyDeliveryEvidence(result) === undefined || canConfirmEarlierSend)
  );
}
