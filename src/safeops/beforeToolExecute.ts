// SafeOps before-tool-execute hook. Wire this immediately before tool execution.
import { SafeOpsAdapterClient } from "./adapterClient.js";

export async function beforeToolExecute(toolCall, context = {}, options = {}) {
  const client = options.client || new SafeOpsAdapterClient(options);
  const event = {
    tool: toolCall.tool || toolCall.name || toolCall.toolName || "unknown",
    action: toolCall.action || toolCall.operation || "execute",
    agentId: toolCall.agentId || context.agentId || "unknown-agent",
    sessionId: toolCall.sessionId || context.sessionId || "unknown-session",
    channelId: toolCall.channelId || context.channelId,
    workspace: toolCall.workspace || context.workspace,
    args: toolCall.args || {},
  };
  const decision = await client.preflight(event);
  if (decision.decision === "allow") return { proceed: true, decision };
  if (decision.decision === "confirm")
    return {
      proceed: false,
      requiresApproval: true,
      approvalId: decision.approvalId || null,
      decision,
    };
  return { proceed: false, blocked: true, decision };
}
