import type { MentionInboxItem } from "../../../../../packages/gateway-protocol/src/schema/human-mentions.js";
import type { AgentsListResult, SessionsListResult } from "../../../api/types.ts";
import { hasOperatorWriteAccess } from "../../../app/operator-access.ts";
import { resolveAgentTextAvatar } from "../../../lib/agents/display.ts";
import {
  resolveAgentAvatarUrl,
  resolveAssistantTextAvatar,
  resolveChatAvatarRenderUrl,
} from "../../../lib/avatar.ts";
import { readCachedAvatarImageUrl } from "../../../lib/identity-avatar-loader.ts";
import {
  resolveChannelSessionInfo,
  resolveSessionDisplayName,
} from "../../../lib/session-display.ts";
import { filterVisibleSessionRows } from "../../../lib/sessions/navigation.ts";
import {
  areUiSessionKeysEquivalent,
  parseAgentSessionKey,
} from "../../../lib/sessions/session-key.ts";
import { isSessionSnoozed } from "../../../lib/sessions/session-snooze.ts";

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

export function resolveAssistantDisplayAvatar(
  props: {
    currentAgentId?: string;
    agents?: AgentsListResult["agents"];
    assistantAvatar: string | null;
    assistantAvatarUrl?: string | null;
    assistantAvatarSource?: string | null;
  },
  id = props.currentAgentId ?? "main",
) {
  const agent = props.agents?.find((entry) => entry.id === id);
  const source = props.assistantAvatarSource;
  const avatar =
    source === undefined
      ? resolveChatAvatarRenderUrl(props.assistantAvatarUrl, {
          identity: {
            avatar: props.assistantAvatar ?? undefined,
            avatarUrl: props.assistantAvatarUrl ?? undefined,
          },
        })
      : source === null
        ? null
        : (readCachedAvatarImageUrl(source) ??
          resolveChatAvatarRenderUrl(source, { identity: { avatar: source } }));
  return {
    id,
    avatar:
      source === undefined ? (avatar ?? (agent ? resolveAgentAvatarUrl(agent) : null)) : avatar,
    textAvatar:
      resolveAssistantTextAvatar(props.assistantAvatar) ??
      (agent ? resolveAgentTextAvatar(agent) : null),
  };
}

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
  mentions: readonly MentionInboxItem[] = [],
  now = Date.now(),
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
          row.hiddenFromInvolvingMe !== true &&
          !isSessionSnoozed(row, now) &&
          (row.lastInteractionAt ?? 0) > 0 &&
          !resolveChannelSessionInfo(row.key, row.channel).channelSession,
      )
      // The Gateway ranks the full query before pagination; preserve that same
      // shared unread/recency order while applying local display exclusions.
      .toSorted(
        (a, b) =>
          Number(b.unread === true) - Number(a.unread === true) ||
          (b.updatedAt ?? 0) - (a.updatedAt ?? 0) ||
          (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
      )
      .slice(0, WELCOME_RECENT_SESSION_LIMIT)
      .map((row) => {
        // Only the current recipient's authorized Inbox supplies attribution.
        // Dismissal/expiry removes this detail, never the session's involvement.
        const mention = mentions
          .filter(
            (item) =>
              item.agentId === agentId &&
              item.expiresAt > now &&
              areUiSessionKeysEquivalent(item.sessionKey, row.key),
          )
          .toSorted((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id))[0];
        return {
          key: row.key,
          name: resolveSessionDisplayName(row.key, row),
          unread: row.unread === true,
          mention,
          updatedAt: row.updatedAt,
        };
      })
  );
}
