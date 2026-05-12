import { resolveSessionConversation } from "../../channels/plugins/session-conversation.js";
import {
  parseThreadSessionSuffix,
  type ParsedThreadSessionSuffix,
} from "../../sessions/session-key-utils.js";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "../../shared/string-coerce.js";

type RawSessionConversationRef = {
  channel: string;
  kind: "group" | "channel";
  rawId: string;
  prefix: string;
};

function parseRawSessionConversationRef(
  sessionKey: string | undefined | null,
): RawSessionConversationRef | null {
  const raw = normalizeOptionalString(sessionKey);
  if (!raw) {
    return null;
  }

  const rawParts = raw.split(":").filter(Boolean);
  const bodyStartIndex =
    rawParts.length >= 3 && normalizeOptionalLowercaseString(rawParts[0]) === "agent" ? 2 : 0;
  const parts = rawParts.slice(bodyStartIndex);
  if (parts.length < 3) {
    return null;
  }

  const channel = normalizeOptionalLowercaseString(parts[0]);
  const kind = normalizeOptionalLowercaseString(parts[1]);
  if (!channel || (kind !== "group" && kind !== "channel")) {
    return null;
  }

  const rawId = normalizeOptionalString(parts.slice(2).join(":"));
  const prefix = normalizeOptionalString(rawParts.slice(0, bodyStartIndex + 2).join(":"));
  if (!rawId || !prefix) {
    return null;
  }

  return { channel, kind, rawId, prefix };
}

function resolveSessionConversationThreadInfo(
  sessionKey: string | undefined | null,
): ParsedThreadSessionSuffix | null {
  const raw = parseRawSessionConversationRef(sessionKey);
  if (!raw) {
    return null;
  }
  const resolved = resolveSessionConversation({
    channel: raw.channel,
    kind: raw.kind,
    rawId: raw.rawId,
  });
  const id = normalizeOptionalString(resolved?.id);
  if (!id) {
    return null;
  }
  const threadId = normalizeOptionalString(resolved?.threadId);
  return {
    baseSessionKey: threadId ? `${raw.prefix}:${id}` : normalizeOptionalString(sessionKey),
    threadId,
  };
}

/**
 * Extract deliveryContext and threadId from a sessionKey.
 * Supports generic :thread: suffixes plus plugin-owned thread/session grammars.
 */
export function parseSessionThreadInfo(
  sessionKey: string | undefined | null,
): ParsedThreadSessionSuffix {
  return resolveSessionConversationThreadInfo(sessionKey) ?? parseThreadSessionSuffix(sessionKey);
}

export function parseSessionThreadInfoFast(
  sessionKey: string | undefined | null,
): ParsedThreadSessionSuffix {
  return parseThreadSessionSuffix(sessionKey);
}
