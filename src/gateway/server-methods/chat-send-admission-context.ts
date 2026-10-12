import { resolveChatSendOriginatingRoute } from "./chat-origin-routing.js";
import { respondChatSendAdmissionError } from "./chat-send-pre-admission.js";
import type { NormalizedChatSendRequest } from "./chat-send-request.js";
import type { PreparedChatSendSession } from "./chat-send-session.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

export function prepareChatSendAdmissionContext(params: {
  request: NormalizedChatSendRequest;
  session: PreparedChatSendSession;
  client: GatewayRequestHandlerOptions["client"];
}) {
  const { request, session, client } = params;
  const { p, explicitOrigin, normalizedAttachments } = request;
  const { cfg, entry, sessionKey, selectedAgent, agentId, clientRunId, resolvedSessionModel } =
    session;
  return {
    chatSendTraceAttributes: {
      runId: clientRunId,
      sessionKey,
      agentId: selectedAgent.agentId ?? agentId,
      provider: resolvedSessionModel.provider,
      model: resolvedSessionModel.model,
      hasAttachments: normalizedAttachments.length > 0,
      hasExplicitOrigin: explicitOrigin !== undefined,
      hasConnectedClient: client?.connect !== undefined,
    },
    originatingRoute: resolveChatSendOriginatingRoute({
      client: request.clientInfo,
      deliver: p.deliver,
      entry,
      explicitOrigin,
      hasConnectedClient: client?.connect !== undefined,
      mainKey: cfg.session?.mainKey,
      sessionKey,
    }),
  };
}

export function assertChatSendSessionTargetOrRespond(params: {
  session: PreparedChatSendSession;
  cleanup: () => void;
  respond: GatewayRequestHandlerOptions["respond"];
}): boolean {
  try {
    params.session.assertSessionTargetCurrent();
    return true;
  } catch (error) {
    params.cleanup();
    respondChatSendAdmissionError(error, params.respond);
    return false;
  }
}
