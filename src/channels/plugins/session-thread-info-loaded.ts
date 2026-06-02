import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  parseRawSessionConversationRef,
  parseThreadSessionSuffix,
  type ParsedThreadSessionSuffix,
} from "../../sessions/session-key-utils.js";
import { getLoadedChannelPluginForRead } from "./registry-loaded-read.js";

type SessionConversationHookResult = {
  id: string;
  threadId?: string | null;
};

function resolveLoadedSessionConversationThreadInfo(
  sessionKey: string | undefined | null,
): ParsedThreadSessionSuffix | null {
  const raw = parseRawSessionConversationRef(sessionKey);
  if (!raw) {
    return null;
  }
  const rawId = raw.rawId.trim();
  if (!rawId) {
    return null;
  }
  // Loaded channel plugins can reinterpret provider-specific conversation ids
  // before the generic `sessionKey:threadId` parser runs.
  const messaging = getLoadedChannelPluginForRead(raw.channel)?.messaging;
  const resolved = messaging?.resolveSessionConversation?.({
    kind: raw.kind,
    rawId,
  }) as SessionConversationHookResult | null | undefined;
  if (!resolved?.id?.trim()) {
    return null;
  }
  const id = resolved.id.trim();
  const threadId = normalizeOptionalString(resolved.threadId);
  return {
    baseSessionKey: threadId ? `${raw.prefix}:${id}` : normalizeOptionalString(sessionKey),
    threadId,
  };
}

/**
 * Resolves thread info from a session key, giving loaded channel plugins first
 * chance to normalize provider-specific conversation references.
 */
export function resolveLoadedSessionThreadInfo(
  sessionKey: string | undefined | null,
): ParsedThreadSessionSuffix {
  return (
    resolveLoadedSessionConversationThreadInfo(sessionKey) ?? parseThreadSessionSuffix(sessionKey)
  );
}
