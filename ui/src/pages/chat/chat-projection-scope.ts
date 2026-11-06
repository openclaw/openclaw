import type { SessionProjectionScope } from "@openclaw/gateway-client/browser";
import {
  resolveUiConversationIdentity,
  type UiSessionDefaultsHost,
} from "../../lib/sessions/session-key.ts";

// Display ownership outlives active-state cleanup. It is not the foreground
// terminal fence: an unowned final cannot suppress authoritative active rows.
export const CHAT_PROJECTION_SCOPE_KEYS = [
  "sessionKey",
  "sessionId",
  "agentId",
  "lifecycleRevision",
  "activeLeafEntryId",
] as const;

export function chatProjectionScopeChanged(
  previous: SessionProjectionScope,
  scope: SessionProjectionScope,
  keys: readonly (keyof SessionProjectionScope)[] = CHAT_PROJECTION_SCOPE_KEYS,
) {
  return keys.some(
    (key) =>
      Object.hasOwn(scope, key) && previous[key] !== undefined && previous[key] !== scope[key],
  );
}

type ChatSessionProjectionScopeOptions = Omit<SessionProjectionScope, "sessionId"> & {
  sessionId?: string | null;
};

/** Every live, pending, terminal, and history path must identify the same pane and branch. */
export function readChatSessionProjectionScope(
  owner: UiSessionDefaultsHost & {
    sessionKey: string;
    currentSessionId?: string | null;
    chatDisplayedLeafEntryId?: string | null;
  },
  options: ChatSessionProjectionScopeOptions = {},
): SessionProjectionScope {
  const sessionId = Object.hasOwn(options, "sessionId")
    ? options.sessionId
    : owner.currentSessionId;
  return {
    sessionKey: resolveUiConversationIdentity(owner, options.sessionKey ?? owner.sessionKey)
      .sessionKey,
    ...(options.agentId ? { agentId: options.agentId } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(options.lifecycleRevision !== undefined
      ? { lifecycleRevision: options.lifecycleRevision }
      : {}),
    ...(Object.hasOwn(options, "activeLeafEntryId") ||
    Object.hasOwn(owner, "chatDisplayedLeafEntryId")
      ? {
          activeLeafEntryId: Object.hasOwn(options, "activeLeafEntryId")
            ? (options.activeLeafEntryId ?? null)
            : (owner.chatDisplayedLeafEntryId ?? null),
        }
      : {}),
  };
}
