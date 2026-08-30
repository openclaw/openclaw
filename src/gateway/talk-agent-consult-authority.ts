import { resolveRealtimeVoiceAgentConsultToolsAllow } from "../talk/agent-consult-tool.js";
import { ADMIN_SCOPE, WRITE_SCOPE } from "./operator-scopes.js";

export type TalkAgentConsultAuthority = {
  senderIsOwner: boolean;
  toolsAllow?: string[];
};

export function resolveTalkAgentConsultAuthority(
  scopes: readonly string[] | undefined,
): TalkAgentConsultAuthority {
  const senderIsOwner = scopes?.includes(ADMIN_SCOPE) === true;
  if (senderIsOwner || scopes?.includes(WRITE_SCOPE) === true) {
    return { senderIsOwner };
  }
  return {
    senderIsOwner: false,
    toolsAllow: resolveRealtimeVoiceAgentConsultToolsAllow("safe-read-only"),
  };
}
