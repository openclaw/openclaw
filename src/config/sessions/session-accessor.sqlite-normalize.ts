import { randomUUID } from "node:crypto";
import type { SessionEntry } from "./types.js";

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

export function resolveSqliteSessionScope(
  entry: { chatType?: unknown },
  sessionKey: string,
): "conversation" | "shared-main" | "group" | "channel" {
  const chatType = normalizeSessionRowChatType(entry.chatType);
  const normalizedKey = sessionKey.trim().toLowerCase();
  if (chatType === "direct" && (normalizedKey === "main" || normalizedKey.endsWith(":main"))) {
    return "shared-main";
  }
  if (chatType === "group" || chatType === "channel") {
    return chatType;
  }
  return "conversation";
}
