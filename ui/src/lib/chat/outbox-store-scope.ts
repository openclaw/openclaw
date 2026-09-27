import {
  DEFAULT_AGENT_ID,
  DEFAULT_MAIN_KEY,
  parseAgentSessionKey,
} from "../sessions/session-key.ts";
import type { StoredChatOutboxScope } from "./outbox-store.ts";

export const UNRESOLVED_GLOBAL_AGENT_SCOPE = "@unresolved";

// Captured scopes never consult current defaults. Fill only an omitted agent;
// explicit conflicting facts must remain visible to stored-scope validation.
export function storedChatOutboxScopeKey(scope: StoredChatOutboxScope): string {
  const normalizedSessionKey = scope.sessionKey.trim().toLowerCase();
  const agentScope =
    scope.agentId ??
    parseAgentSessionKey(scope.sessionKey)?.agentId ??
    (normalizedSessionKey === "global" || normalizedSessionKey === DEFAULT_MAIN_KEY
      ? UNRESOLVED_GLOBAL_AGENT_SCOPE
      : DEFAULT_AGENT_ID);
  return `${scope.sessionKey}\u0000agent:${agentScope}`;
}
