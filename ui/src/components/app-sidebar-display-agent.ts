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
  const creation = input.creation;
  const sessionAgentId = parseAgentSessionKey(input.sessionKey)?.agentId;
  if (
    !input.chipMode ||
    !creation ||
    creation.creation.admitted ||
    !sessionAgentId ||
    !areUiSessionKeysEquivalent(input.sessionKey, creation.creation.sessionKey)
  ) {
    return active;
  }
  // An agent being created has no selection yet. Name it from the pending creation,
  // then from the row its durable admission added, then from the chat that was opened.
  const agentId = normalizeAgentId(sessionAgentId);
  const provisional =
    (input.pending && normalizeAgentId(input.pending.id) === agentId ? input.pending : undefined) ??
    input.roster.find((agent) => normalizeAgentId(agent.id) === agentId) ??
    (creation.displayName ? { id: sessionAgentId, name: creation.displayName } : undefined);
  if (!provisional) {
    return active;
  }
  return {
    ...active,
    activeId: provisional.id,
    agent: provisional,
    identity: active.identities.get(agentId) ?? null,
  };
}
