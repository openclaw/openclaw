import type { AgentIdentityResult, AgentsListResult, GatewaySessionRow } from "../../api/types.ts";
import { resolveAgentAvatarUrl } from "../avatar.ts";
import { isSessionRunActive } from "../session-run-state.ts";
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
  return selectableAgentsList(roster).agents.map((agent) => {
    const identity = identityFor(agent.id);
    const name = normalizeAgentLabel(agent, identity);
    const mainKey = resolveUiConversationIdentity(
      { agentsList: roster },
      roster.mainKey,
      agent.id,
    ).sessionKey;
    const sessions = rows.filter(
      (row) => resolveUiSessionRowAgentId(row, roster.defaultId) === agent.id,
    );
    const recent = sessions.reduce<GatewaySessionRow | undefined>(
      (latest, row) => (!latest || (row.updatedAt ?? 0) > (latest.updatedAt ?? 0) ? row : latest),
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
      activeNow: sessions.some(isSessionRunActive),
      unreadCount: sessions.filter((row) => row.unread && !row.archived).length,
      lastActiveAt: recent?.updatedAt ?? 0,
      preview: (main ?? recent)?.lastMessagePreview,
    };
  });
}
