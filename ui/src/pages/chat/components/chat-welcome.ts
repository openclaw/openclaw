import type { AgentsListResult, SessionsListResult } from "../../../api/types.ts";
import { hasOperatorWriteAccess } from "../../../app/operator-access.ts";
import { resolveAgentTextAvatar } from "../../../lib/agents/display.ts";
import {
  resolveAgentAvatarUrl,
  resolveAssistantTextAvatar,
  resolveChatAvatarRenderUrl,
} from "../../../lib/avatar.ts";
import { readCachedAvatarImageUrl } from "../../../lib/identity-avatar-loader.ts";
import { resolveChannelSessionInfo } from "../../../lib/session-display.ts";
import { filterVisibleSessionRows } from "../../../lib/sessions/navigation.ts";
import {
  areUiSessionKeysEquivalent,
  parseAgentSessionKey,
} from "../../../lib/sessions/session-key.ts";

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
 * Whether the active agent already has user-created chats: the sidebar's
 * visible-row rules minus channel-originated sessions and the current draft.
 * Starter suggestions are for a first chat only.
 */
export function hasWelcomeRecentSessions(
  sessions: SessionsListResult | null | undefined,
  sessionKey: string | undefined,
  defaultAgentId: string,
): boolean {
  if (!sessions) {
    return false;
  }
  const agentId = parseAgentSessionKey(sessionKey)?.agentId ?? defaultAgentId;
  return filterVisibleSessionRows(sessions.sessions, {
    agentId,
    defaultAgentId,
    filterByAgent: true,
  }).some(
    (row) =>
      !areUiSessionKeysEquivalent(row.key, sessionKey) &&
      !resolveChannelSessionInfo(row.key, row.channel).channelSession,
  );
}
