import type { ApplicationContext } from "../app/context.ts";
import { listSelectableAgents } from "../lib/agents/display.ts";
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
  // Until admission, the displayed recipient belongs to the visible creation, not the selected scope.
  const sessionAgentId =
    input.chipMode &&
    creation &&
    !creation.creation.admitted &&
    areUiSessionKeysEquivalent(sessionKey, creation.creation.sessionKey) &&
    parseAgentSessionKey(sessionKey)?.agentId;
  const id = sessionAgentId && normalizeAgentId(sessionAgentId);
  const provisional =
    id &&
    (pending && normalizeAgentId(pending.id) === id
      ? pending
      : (findAgent(id) ??
        (creation.displayName ? { id: sessionAgentId, name: creation.displayName } : undefined)));
  const activeId = provisional ? provisional.id : input.activeId;
  const identities = new Map(
    input.identities.map((identity) => [identity.agentId, identity] as const),
  );
  return {
    activeId,
    agent: provisional || findAgent(activeId),
    agents: listSelectableAgents(roster),
    identity: identities.get(provisional && id ? id : activeId) ?? null,
    identities,
  };
}
