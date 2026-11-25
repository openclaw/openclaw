import type { GatewayAgentRow } from "../api/types.ts";
import type { ApplicationContext } from "../app/context.ts";
import { listSelectableAgents } from "../lib/agents/display.ts";
import { resolveAgentAvatarUrl } from "../lib/avatar.ts";
import {
  areUiSessionKeysEquivalent,
  normalizeAgentId,
  parseAgentSessionKey,
} from "../lib/sessions/session-key.ts";

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
  const { creation, pending, sessionKey, roster } = input;
  const findAgent = (id: string) => roster.find((row) => normalizeAgentId(row.id) === id);
  const creationAgentId =
    input.chipMode &&
    creation &&
    areUiSessionKeysEquivalent(sessionKey, creation.creation.sessionKey) &&
    parseAgentSessionKey(sessionKey)?.agentId;
  // Until admission, the displayed recipient belongs to the visible creation, not the selected scope.
  const sessionAgentId = creation && !creation.creation.admitted && creationAgentId;
  const id = sessionAgentId && normalizeAgentId(sessionAgentId);
  const provisional: GatewayAgentRow | undefined =
    creation && sessionAgentId && id
      ? pending && normalizeAgentId(pending.id) === id
        ? pending
        : (findAgent(id) ??
          (creation.displayName ? { id: sessionAgentId, name: creation.displayName } : undefined))
      : undefined;
  const activeId = provisional ? provisional.id : input.activeId;
  const identities = new Map(
    input.identities.map((identity) => [identity.agentId, identity] as const),
  );
  const agent = provisional || findAgent(activeId);
  const identity = identities.get(provisional && id ? id : activeId) ?? null;
  // A Template's catalog image stands in while its agent is created and set up, until the
  // agent has an avatar of its own. The agent is first admitted without one, and a cached
  // identity can still say so for a moment after the Template's identity is written.
  const avatarUrl =
    creation &&
    creationAgentId &&
    agent &&
    normalizeAgentId(agent.id) === normalizeAgentId(creationAgentId) &&
    !resolveAgentAvatarUrl(agent, identity)
      ? creation.avatarUrl
      : undefined;
  return {
    activeId,
    agent: agent && avatarUrl ? { ...agent, identity: { ...agent.identity, avatarUrl } } : agent,
    agents: listSelectableAgents(roster),
    identity: avatarUrl && identity ? { ...identity, avatar: avatarUrl } : identity,
    identities,
  };
}
