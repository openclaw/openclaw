import type { AgentsListResult, SessionsListResult } from "../../../api/types.ts";
import { hasOperatorWriteAccess } from "../../../app/operator-access.ts";
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

const OPERATOR_WELCOME_SUGGESTION_KEYS = [
  "chat.welcome.suggestions.whatCanYouDo",
  "chat.welcome.suggestions.summarizeRecentSessions",
  "chat.welcome.suggestions.configureChannel",
  "chat.welcome.suggestions.checkSystemHealth",
] as const;

const SESSION_SCOPED_WELCOME_SUGGESTION_KEYS = [
  "chat.welcome.suggestions.whatCanYouDo",
  "chat.welcome.suggestions.exploreOpenClaw",
  "chat.welcome.suggestions.investigateInSandbox",
  "chat.welcome.suggestions.openDraftPullRequest",
] as const;

export type WelcomeSuggestionAuth = { role?: string; scopes?: readonly string[] } | null;

/**
 * Starter prompts the connected principal can act on. Session-scoped grants
 * (the visitor guest policy) lack `operator.write`, so they cannot configure
 * channels or read Gateway health; offer work their own sandboxed sessions can
 * do instead. Missing auth keeps the operator set, matching operator-access.
 */
export function resolveWelcomeSuggestionKeys(auth: WelcomeSuggestionAuth | undefined) {
  return hasOperatorWriteAccess(auth ?? null)
    ? OPERATOR_WELCOME_SUGGESTION_KEYS
    : SESSION_SCOPED_WELCOME_SUGGESTION_KEYS;
}

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

export type WelcomeRecentSession = ReturnType<typeof prepareWelcomeRecentSessions>[number];

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
) {
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
