import {
  isSubagentSessionRow,
  isSystemCreatedSessionRow,
} from "../../../../src/shared/session-list-visibility.ts";
import type { AgentIdentityResult, AgentsListResult, GatewaySessionRow } from "../../api/types.ts";
import { resolveAgentAvatarUrl } from "../avatar.ts";
import { isSessionRunStateActive } from "../session-run-state.ts";
import {
  resolveUiConversationIdentity,
  resolveUiSessionRowAgentId,
} from "../sessions/session-key.ts";
import { normalizeAgentLabel, resolveAgentTextAvatar, selectableAgentsList } from "./display.ts";

/** Shared identity and activity in configured roster order. */
export function agentRosterCards(
  roster: AgentsListResult | undefined,
  rows: readonly GatewaySessionRow[],
  identityFor: (id: string) => AgentIdentityResult | null = () => null,
) {
  if (!roster) {
    return [];
  }
  const agents = selectableAgentsList(roster).agents;
  if (agents.length === 0) {
    return [];
  }
  const sessionsByAgent = new Map<string, GatewaySessionRow[]>();
  rows.forEach((row) => {
    const agentId = resolveUiSessionRowAgentId(row, roster.defaultId);
    const sessions = sessionsByAgent.get(agentId) ?? [];
    sessions.push(row);
    sessionsByAgent.set(agentId, sessions);
  });
  return agents.map((agent) => {
    const identity = identityFor(agent.id);
    const name = normalizeAgentLabel(agent, identity);
    const mainKey = resolveUiConversationIdentity(
      { agentsList: roster },
      roster.mainKey,
      agent.id,
    ).sessionKey;
    const sessions = sessionsByAgent.get(agent.id) ?? [];
    const recent = sessions.reduce<GatewaySessionRow | undefined>(
      (latest, row) => (!latest || (row.updatedAt ?? 0) > (latest.updatedAt ?? 0) ? row : latest),
      undefined,
    );
    const lastAssistantMessage = sessions.reduce<GatewaySessionRow["lastAssistantMessage"]>(
      (latest, row) =>
        row.lastAssistantMessage &&
        !isSubagentSessionRow(row.key, row) &&
        !isSystemCreatedSessionRow(row) &&
        (!latest || row.lastAssistantMessage.timestamp > latest.timestamp)
          ? row.lastAssistantMessage
          : latest,
      undefined,
    );
    const main = sessions.find((row) => row.key === mainKey) ?? sessions.find((row) => row.isMain);
    return {
      id: agent.id,
      name,
      role: agent.identity?.theme,
      model: agent.model?.primary,
      avatar: resolveAgentAvatarUrl(agent, identity),
      textAvatar: resolveAgentTextAvatar(agent, identity),
      mainKey,
      activeNow: sessions.some(isSessionRunStateActive),
      lastActiveAt: recent?.updatedAt ?? 0,
      preview: (main ?? recent)?.lastMessagePreview,
      assistantPreview: lastAssistantMessage?.text,
    };
  });
}
