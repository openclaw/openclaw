import {
  GATEWAY_CLIENT_CAPS,
  hasGatewayClientCap,
} from "../../../packages/gateway-protocol/src/client-info.js";
import { chatRunBelongsToSelectedAgent } from "../chat-run-owner.js";
import { tryResolveSessionCompatibilityOwnerAgentId } from "../session-request-agent.js";
import type { StartChatDispatchParams } from "./chat-send-agent-dispatch.types.js";

export function registerChatRunToolEventRecipients(params: {
  client: StartChatDispatchParams["client"];
  context: StartChatDispatchParams["context"];
  session: Pick<StartChatDispatchParams["session"], "cfg" | "sessionKey" | "selectedAgent">;
  runId: string;
}): void {
  const {
    client,
    context,
    session: { cfg, sessionKey, selectedAgent },
    runId,
  } = params;
  const connId = typeof client?.connId === "string" ? client.connId : undefined;
  const wantsToolEvents = hasGatewayClientCap(
    client?.connect?.caps,
    GATEWAY_CLIENT_CAPS.TOOL_EVENTS,
  );
  if (connId && wantsToolEvents) {
    context.registerToolEventRecipient(runId, connId);
    // Register for any other active runs *in the same session* so
    // late-joining clients (e.g. page refresh mid-response) receive
    // in-progress tool events without leaking cross-session data.
    const compatibilityOwnerAgentId = tryResolveSessionCompatibilityOwnerAgentId(cfg, sessionKey);
    const selectedSessionAgentId = selectedAgent.agentId;
    for (const [activeRunId, active] of context.chatAbortControllers) {
      const sameSelectedAgent =
        selectedSessionAgentId !== undefined &&
        chatRunBelongsToSelectedAgent({
          agentId: active.agentId,
          sessionKey: active.sessionKey,
          defaultAgentId: compatibilityOwnerAgentId,
          selectedAgentId: selectedSessionAgentId,
        });
      const sameSession = active.sessionKey === sessionKey && sameSelectedAgent;
      if (activeRunId !== runId && sameSession) {
        context.registerToolEventRecipient(activeRunId, connId);
      }
    }
  }
}
