import { randomUUID } from "node:crypto";
import { isIncognitoSessionKey } from "../../routing/session-key.js";
import { mergeSessionEntry, type SessionEntry } from "./types.js";

export { normalizeNullableString as normalizeText } from "@openclaw/normalization-core/string-coerce";

export function createFallbackSessionEntry(patch: Partial<SessionEntry>): SessionEntry {
  const now = Date.now();
  return {
    sessionId: patch.sessionId ?? randomUUID(),
    updatedAt: patch.updatedAt ?? now,
    ...patch,
  };
}

export function normalizeSessionRowChatType(value: unknown): "direct" | "group" | "channel" | null {
  if (value === "direct" || value === "group" || value === "channel") {
    return value;
  }
  return null;
}

export function createInboundSessionFallback(sessionKey: string): SessionEntry {
  const patch = isIncognitoSessionKey(sessionKey) ? {} : { lifecycleRevision: randomUUID() };
  return mergeSessionEntry(undefined, patch);
}
