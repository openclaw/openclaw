import { resolveSessionAgentId } from "../../agents/agent-scope.js";
import type { OpenClawConfig } from "../../config/config.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";

export type OutboundSessionContext = {
  /** Canonical session key used for internal hook dispatch. */
  key?: string;
  /** Active agent id used for workspace-scoped media roots. */
  agentId?: string;
  /** Originating sender id used for sender-scoped outbound media policy. */
  requesterSenderId?: string;
};

export function buildOutboundSessionContext(params: {
  cfg: OpenClawConfig;
  sessionKey?: string | null;
  agentId?: string | null;
  requesterSenderId?: string | null;
}): OutboundSessionContext | undefined {
  const key = normalizeOptionalString(params.sessionKey);
  const explicitAgentId = normalizeOptionalString(params.agentId);
  const requesterSenderId = normalizeOptionalString(params.requesterSenderId);
  const derivedAgentId = key
    ? resolveSessionAgentId({ sessionKey: key, config: params.cfg })
    : undefined;
  const agentId = explicitAgentId ?? derivedAgentId;
  if (!key && !agentId && !requesterSenderId) {
    return undefined;
  }
  return {
    ...(key ? { key } : {}),
    ...(agentId ? { agentId } : {}),
    ...(requesterSenderId ? { requesterSenderId } : {}),
  };
}
