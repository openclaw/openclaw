import { normalizeAgentRunTerminalReceipt } from "../../agents/agent-run-terminal-receipt.js";
import { normalizeAgentRunTerminalReplySnapshot } from "../../agents/agent-run-terminal-reply.js";
import type { EmbeddedAgentRunMeta } from "../../agents/embedded-agent-runner/types.js";

export function readFollowupTerminalReply(runId: string, meta: EmbeddedAgentRunMeta | undefined) {
  const terminalReply = normalizeAgentRunTerminalReplySnapshot(meta?.terminalReply);
  const receipt = normalizeAgentRunTerminalReceipt(meta?.agentMeta?.terminalReceipt);
  return {
    terminalReply,
    ...(terminalReply?.disposition === "visible" ? { replyText: terminalReply.text } : {}),
    ...(receipt?.runId === runId && receipt.sourceReplyDelivered
      ? { sourceReplyDelivered: true as const }
      : {}),
  };
}
