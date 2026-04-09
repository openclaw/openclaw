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
  /** Originating sender display name for name-keyed sender policy matching. */
  requesterSenderName?: string;
  /** Originating sender username for username-keyed sender policy matching. */
  requesterSenderUsername?: string;
  /** Originating sender E.164 phone number for e164-keyed sender policy matching. */
  requesterSenderE164?: string;
};

export function buildOutboundSessionContext(params: {
  cfg: OpenClawConfig;
  sessionKey?: string | null;
  agentId?: string | null;
  requesterSenderId?: string | null;
  requesterSenderName?: string | null;
  requesterSenderUsername?: string | null;
  requesterSenderE164?: string | null;
}): OutboundSessionContext | undefined {
  const key = normalizeOptionalString(params.sessionKey);
  const explicitAgentId = normalizeOptionalString(params.agentId);
  const requesterSenderId = normalizeOptionalString(params.requesterSenderId);
  const requesterSenderName = normalizeOptionalString(params.requesterSenderName);
  const requesterSenderUsername = normalizeOptionalString(params.requesterSenderUsername);
  const requesterSenderE164 = normalizeOptionalString(params.requesterSenderE164);
  const derivedAgentId = key
    ? resolveSessionAgentId({ sessionKey: key, config: params.cfg })
    : undefined;
  const agentId = explicitAgentId ?? derivedAgentId;
  if (
    !key &&
    !agentId &&
    !requesterSenderId &&
    !requesterSenderName &&
    !requesterSenderUsername &&
    !requesterSenderE164
  ) {
    return undefined;
  }
  return {
    ...(key ? { key } : {}),
    ...(agentId ? { agentId } : {}),
    ...(requesterSenderId ? { requesterSenderId } : {}),
    ...(requesterSenderName ? { requesterSenderName } : {}),
    ...(requesterSenderUsername ? { requesterSenderUsername } : {}),
    ...(requesterSenderE164 ? { requesterSenderE164 } : {}),
  };
}
