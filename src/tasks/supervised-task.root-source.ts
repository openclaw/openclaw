import {
  resolveConversationRegistryScope,
  resolveCurrentSessionPrimaryConversation,
} from "../config/sessions/conversation-registry.js";
import { resolveConversationRouteFingerprint } from "../config/sessions/conversation-route-fingerprint.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { SupervisedTaskSource } from "./supervised-task.source.js";

/** The root ingress supplies authenticated session identity and its host-owned
 * input ID. Never infer either from message text or model output. */
export function bindSupervisedRootSource(params: {
  config: OpenClawConfig;
  agentId: string;
  sessionKey: string;
  sessionId: string;
  namespace: SupervisedTaskSource["namespace"];
  inputId: string;
}): SupervisedTaskSource {
  const conversation = resolveCurrentSessionPrimaryConversation({
    ...resolveConversationRegistryScope(params),
    sessionKey: params.sessionKey,
    sessionId: params.sessionId,
  });
  return {
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    sessionId: params.sessionId,
    namespace: params.namespace,
    inputId: params.inputId,
    ownerScope: `session:${params.agentId}:${params.sessionKey}`,
    ...(conversation
      ? {
          conversationRef: conversation.conversationRef,
          routeFingerprint: resolveConversationRouteFingerprint(conversation),
        }
      : {}),
  };
}
