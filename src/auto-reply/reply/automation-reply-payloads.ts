import { hasPendingAutomationContinuation } from "../../cron/automation-result.js";
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
  const reasoningPayloadsEnabled = !execution.automation && opts?.reasoningPayloadsEnabled === true;
  return {
    blocked,
    successfulTerminal,
    authoredSilence,
    pendingContinuation,
    automationNoChange,
    reasoningPayloadsEnabled,
  };
}
