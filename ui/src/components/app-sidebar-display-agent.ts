import type { ApplicationContext } from "../app/context.ts";
import {
  areUiSessionKeysEquivalent,
  normalizeAgentId,
  parseAgentSessionKey,
} from "../lib/sessions/session-key.ts";
import { resolveActiveSidebarAgent } from "./app-sidebar-session-navigation-logic.ts";

/** Show a provisional chat's owner without changing the selected-agent scope. */
export function resolveSidebarDisplayAgent(input: {
  activeId: string;
  roster: NonNullable<ApplicationContext["agents"]["state"]["agentsList"]>["agents"];
  identities: ReturnType<ApplicationContext["agentIdentity"]["entries"]>;
  pending: ApplicationContext["agents"]["state"]["pendingAgent"];
  creation: ReturnType<ApplicationContext["chatSubmissions"]["readCreate"]>;
  sessionKey: string;
  chipMode: boolean;
}) {
  const active = resolveActiveSidebarAgent(input);
  const sessionAgentId = parseAgentSessionKey(input.sessionKey)?.agentId;
  if (
    input.chipMode &&
    input.pending &&
    input.creation &&
    !input.creation.creation.admitted &&
    areUiSessionKeysEquivalent(input.sessionKey, input.creation.creation.sessionKey) &&
    sessionAgentId &&
    normalizeAgentId(sessionAgentId) === normalizeAgentId(input.pending.id)
  ) {
    return { ...active, activeId: input.pending.id, agent: input.pending, identity: null };
  }
  return active;
}
