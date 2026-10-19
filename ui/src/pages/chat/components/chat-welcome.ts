import type { AgentsListResult, SessionsListResult } from "../../../api/types.ts";
import { resolveAgentTextAvatar } from "../../../lib/agents/display.ts";
import {
  resolveAgentAvatarUrl,
  resolveAssistantTextAvatar,
  resolveChatAvatarRenderUrl,
} from "../../../lib/avatar.ts";
import {
  resolveChannelSessionInfo,
  resolveSessionDisplayName,
  resolveSessionWorkSubtitle,
} from "../../../lib/session-display.ts";
import { filterVisibleSessionRows } from "../../../lib/sessions/navigation.ts";
import {
  areUiSessionKeysEquivalent,
  parseAgentSessionKey,
} from "../../../lib/sessions/session-key.ts";

const WELCOME_RECENT_SESSION_LIMIT = 5;

export function resolveAssistantDisplayAvatar(props: {
  currentAgentId?: string;
  agents?: AgentsListResult["agents"];
  assistantAvatar: string | null;
  assistantAvatarUrl?: string | null;
}) {
  const id = props.currentAgentId ?? "main";
  const agent = props.agents?.find((entry) => entry.id === id);
  const avatar = resolveChatAvatarRenderUrl(props.assistantAvatarUrl, {
    identity: {
      avatar: props.assistantAvatar ?? undefined,
      avatarUrl: props.assistantAvatarUrl ?? undefined,
    },
  });
  return {
    id,
    avatar: avatar ?? (agent ? resolveAgentAvatarUrl(agent) : null),
    textAvatar:
      resolveAssistantTextAvatar(props.assistantAvatar) ??
      (agent ? resolveAgentTextAvatar(agent) : null),
  };
}

export type WelcomeRecentSession = {
  key: string;
  name: string;
  subtitle: string | undefined;
  updatedAt: number | null | undefined;
};

/**
 * Recent user-created chats for the welcome screen: the sidebar's visible-row
 * rules (no archived/cron/subagent/spawned rows, scoped to the active agent)
 * minus channel-originated sessions — those live in their channel sections and
 * are not something the user "starts" from here.
 */
export function prepareWelcomeRecentSessions(
  sessions: SessionsListResult | null | undefined,
  sessionKey: string | undefined,
  defaultAgentId: string,
): WelcomeRecentSession[] {
  if (!sessions) {
    return [];
  }
  const agentId = parseAgentSessionKey(sessionKey)?.agentId ?? defaultAgentId;
  return (
    filterVisibleSessionRows(sessions.sessions, {
      agentId,
      defaultAgentId,
      filterByAgent: true,
    })
      .filter(
        (row) =>
          !areUiSessionKeysEquivalent(row.key, sessionKey) &&
          !resolveChannelSessionInfo(row.key, row.channel).channelSession,
      )
      // Pure recency, unlike the sidebar's pin-aware sort: a "Recent chats"
      // list capped at five must not let stale pinned rows hide newer chats.
      .toSorted((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0) || a.key.localeCompare(b.key))
      .slice(0, WELCOME_RECENT_SESSION_LIMIT)
      .map((row) => ({
        key: row.key,
        name: resolveSessionDisplayName(row.key, row),
        subtitle: resolveSessionWorkSubtitle(row),
        updatedAt: row.updatedAt,
      }))
  );
}
