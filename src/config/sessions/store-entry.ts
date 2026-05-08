import { normalizeLowercaseStringOrEmpty } from "../../shared/string-coerce.js";
import type { SessionEntry } from "./types.js";

export function normalizeSessionRowKey(sessionKey: string): string {
  return normalizeLowercaseStringOrEmpty(sessionKey);
}

export function resolveSessionRowEntry(params: {
  entries: Record<string, SessionEntry>;
  sessionKey: string;
}): {
  normalizedKey: string;
  existing: SessionEntry | undefined;
} {
  const trimmedKey = params.sessionKey.trim();
  const normalizedKey = normalizeSessionRowKey(trimmedKey);
  return {
    normalizedKey,
    existing: params.entries[normalizedKey],
  };
}
