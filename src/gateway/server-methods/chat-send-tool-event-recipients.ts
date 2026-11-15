import {
  getRpcSourceIdentity,
  isRpcSourceActive,
  listRpcSourceEntries,
} from "../../sessions/session-controller.rpc-sources.js";
import { resolveAgentTurnRunObserver } from "../agent-turn/principal.js";
import { chatRunBelongsToSelectedAgent } from "../chat-run-owner.js";
import { tryResolveSessionCompatibilityOwnerAgentId } from "../session-request-agent.js";
import { captureRpcSourceScopeMatcher } from "../session-runtime-scope.js";
import type { StartChatDispatchParams } from "./chat-send-agent-dispatch.types.js";

export function registerChatSendToolEventRecipients(
  params: Pick<StartChatDispatchParams, "client" | "context"> &
    Pick<StartChatDispatchParams["session"], "cfg" | "sessionKey" | "selectedAgent" | "storePath">,
  runId: string,
): void {
  const { client, context, cfg, sessionKey, selectedAgent, storePath } = params;
  const observeRun = resolveAgentTurnRunObserver({
    principal: client,
    registerToolEventRecipient: context.registerToolEventRecipient,
  });
  if (observeRun) {
    observeRun(runId);
    // Register for any other active runs *in the same session* so
    // late-joining clients (e.g. page refresh mid-response) receive
    // in-progress tool events without leaking cross-session data.
    const compatibilityOwnerAgentId = tryResolveSessionCompatibilityOwnerAgentId(cfg, sessionKey);
    const matchesScope = captureRpcSourceScopeMatcher({
      storePath,
      resolveGatewayContext: context.resolveGatewayContext,
    });
    for (const [activeRunId, active] of listRpcSourceEntries()) {
      const identity = getRpcSourceIdentity(active);
      const sameSelectedAgent =
        selectedAgent.agentId !== undefined &&
        chatRunBelongsToSelectedAgent({
          agentId: identity.agentId,
          sessionKey: identity.sessionKey,
          defaultAgentId: compatibilityOwnerAgentId,
          selectedAgentId: selectedAgent.agentId,
        });
      const sameSession = identity.sessionKey === sessionKey && sameSelectedAgent;
      if (
        activeRunId !== runId &&
        sameSession &&
        matchesScope(active) &&
        isRpcSourceActive(active)
      ) {
        observeRun(activeRunId);
      }
    }
  }
}
