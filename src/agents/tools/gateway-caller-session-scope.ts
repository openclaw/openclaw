import type { SessionEventSourcePolicy } from "../../auto-reply/reply/session-event-contract.js";

type SessionScopedToolsAllowOwner = {
  agentId: string;
  sessionKey: string;
  sessionEventToolsAllow?: readonly string[];
  sessionEventToolsAllowSessionScoped?: SessionEventSourcePolicy["conversationScope"];
};

/** Nested owners cannot erase a narrower ancestor's ceiling or transfer it across sessions. */
export function inheritSessionScopedToolsAllow(
  inheritedOwner: SessionScopedToolsAllowOwner | undefined,
  identity: SessionScopedToolsAllowOwner,
): SessionScopedToolsAllowOwner["sessionEventToolsAllowSessionScoped"] {
  return !inheritedOwner ||
    (inheritedOwner.agentId === identity.agentId.trim() &&
      inheritedOwner.sessionKey === identity.sessionKey.trim() &&
      (!inheritedOwner.sessionEventToolsAllow ||
        inheritedOwner.sessionEventToolsAllowSessionScoped))
    ? identity.sessionEventToolsAllowSessionScoped
    : undefined;
}
