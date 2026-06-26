// Shared session chat type helpers expose cross-module chat type classification.
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { parseAgentSessionKey } from "./session-key-utils.js";

export type SessionKeyChatType = "direct" | "group" | "channel" | "unknown";

const CANONICAL_PEER_KINDS = new Set(["direct", "dm", "group", "channel"]);

function deriveCanonicalSessionChatType(scopedSessionKey: string): SessionKeyChatType | undefined {
  const parts = scopedSessionKey.split(":").filter(Boolean);
  // A second agent wrapper is opaque plugin identity, never a channel route.
  if (parts[0] === "agent") {
    return undefined;
  }
  const peerKind = CANONICAL_PEER_KINDS.has(parts[1] ?? "")
    ? parts[1]
    : CANONICAL_PEER_KINDS.has(parts[2] ?? "")
      ? parts[2]
      : undefined;
  if (peerKind === "group" || peerKind === "channel") {
    return peerKind;
  }
  if (peerKind === "direct" || peerKind === "dm") {
    return "direct";
  }
  return undefined;
}

function deriveBuiltInLegacySessionChatType(
  scopedSessionKey: string,
): SessionKeyChatType | undefined {
  if (/^group:[^:]+$/.test(scopedSessionKey)) {
    return "group";
  }
  if (/^(?:whatsapp:)?[^:]+@g\.us$/.test(scopedSessionKey)) {
    return "group";
  }
  if (/^discord:(?:[^:]+:)?guild-[^:]+:channel-[^:]+$/.test(scopedSessionKey)) {
    return "channel";
  }
  return undefined;
}

export function deriveSessionChatTypeFromScopedKey(
  scopedSessionKey: string,
  deriveLegacySessionChatTypes: Array<
    (scopedSessionKey: string) => SessionKeyChatType | undefined
  > = [],
): SessionKeyChatType {
  const canonical = deriveCanonicalSessionChatType(scopedSessionKey);
  if (canonical) {
    return canonical;
  }
  const builtInLegacy = deriveBuiltInLegacySessionChatType(scopedSessionKey);
  if (builtInLegacy) {
    return builtInLegacy;
  }
  for (const deriveLegacySessionChatType of deriveLegacySessionChatTypes) {
    const derived = deriveLegacySessionChatType(scopedSessionKey);
    if (derived) {
      return derived;
    }
  }
  return "unknown";
}

/**
 * Best-effort chat-type extraction from session keys across canonical and legacy formats.
 */
export function deriveSessionChatTypeFromKey(
  sessionKey: string | undefined | null,
  deriveLegacySessionChatTypes: Array<
    (scopedSessionKey: string) => SessionKeyChatType | undefined
  > = [],
): SessionKeyChatType {
  const raw = normalizeLowercaseStringOrEmpty(sessionKey);
  if (!raw) {
    return "unknown";
  }
  const scoped = parseAgentSessionKey(raw)?.rest ?? raw;
  return deriveSessionChatTypeFromScopedKey(scoped, deriveLegacySessionChatTypes);
}
