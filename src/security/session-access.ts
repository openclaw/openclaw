import type { OpenClawConfig } from "../config/config.js";
import { createAgentToAgentPolicy } from "../agents/tools/sessions-helpers.js";
import { normalizeMainKey, resolveAgentIdFromSessionKey } from "../routing/session-key.js";
import { emitSecurityEvent } from "./event-logger.js";

export type SessionAccessType = "transcript" | "memory" | "metadata" | "list";

export type SessionAccessDecision = {
  allowed: boolean;
  reason?: string;
};

export function authorizeSessionAccess(params: {
  callerSessionKey: string;
  targetSessionKey: string;
  accessType: SessionAccessType;
  config: OpenClawConfig;
}): SessionAccessDecision {
  const { callerSessionKey, targetSessionKey, accessType, config } = params;

  // 1. Same session — always allowed
  if (callerSessionKey === targetSessionKey) {
    return { allowed: true };
  }

  // 2. Main/gateway session as caller — always allowed
  const mainKey = normalizeMainKey(config.session?.mainKey);
  // The main session key is "agent:{agentId}:{mainKey}" where mainKey defaults to "main".
  // Check if the caller IS a main session by extracting agent ID and rebuilding the main key.
  const callerAgentId = resolveAgentIdFromSessionKey(callerSessionKey);
  const callerMainSessionKey = `agent:${callerAgentId}:${mainKey}`;
  if (callerSessionKey === callerMainSessionKey) {
    return { allowed: true };
  }

  // 3. Same agent, cross-session
  const targetAgentId = resolveAgentIdFromSessionKey(targetSessionKey);
  if (callerAgentId === targetAgentId) {
    // metadata and list access types are allowed (sessions can see each other exists)
    if (accessType === "metadata" || accessType === "list") {
      return { allowed: true };
    }

    // transcript and memory access types are denied
    const reason = "Cross-session transcript/memory access denied within same agent";
    emitSecurityEvent({
      eventType: "policy.violation",
      timestamp: new Date().toISOString(),
      sessionKey: callerSessionKey,
      severity: "warn",
      action: "blocked",
      detail: `Cross-session ${accessType} access denied: ${callerSessionKey} → ${targetSessionKey}`,
      meta: { callerSessionKey, targetSessionKey, accessType },
    });
    return { allowed: false, reason };
  }

  // 4. Cross-agent — defer to A2A policy
  const a2aPolicy = createAgentToAgentPolicy(config);
  if (a2aPolicy.isAllowed(callerAgentId, targetAgentId)) {
    return { allowed: true };
  }

  const reason = "Agent-to-agent access denied by tools.agentToAgent policy";
  emitSecurityEvent({
    eventType: "policy.violation",
    timestamp: new Date().toISOString(),
    sessionKey: callerSessionKey,
    severity: "warn",
    action: "blocked",
    detail: `Cross-session ${accessType} access denied: ${callerSessionKey} → ${targetSessionKey}`,
    meta: { callerSessionKey, targetSessionKey, accessType },
  });
  return { allowed: false, reason };
}
