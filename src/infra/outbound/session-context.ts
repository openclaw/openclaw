import { resolveSessionAgentId } from "../../agents/agent-scope.js";
import type { OpenClawConfig } from "../../config/config.js";

export type OutboundSessionContext = {
  /** Canonical session key used for internal hook dispatch. */
  key?: string;
  /** Active agent id used for workspace-scoped media roots. */
  agentId?: string;
};

function normalizeOptionalString(value?: string | null): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function buildOutboundSessionContext(params: {
  cfg: OpenClawConfig;
  sessionKey?: string | null;
  agentId?: string | null;
}): OutboundSessionContext | undefined {
  const key = normalizeOptionalString(params.sessionKey);
  const explicitAgentId = normalizeOptionalString(params.agentId);
  const derivedAgentId = key
    ? resolveSessionAgentId({ sessionKey: key, config: params.cfg })
    : undefined;
  const agentId = explicitAgentId ?? derivedAgentId;
  if (!key && !agentId) {
    return undefined;
  }
  return {
    ...(key ? { key } : {}),
    ...(agentId ? { agentId } : {}),
  };
}
