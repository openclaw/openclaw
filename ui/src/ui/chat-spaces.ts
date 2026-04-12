import { getSafeLocalStorage } from "../local-storage.ts";
import { normalizeLowercaseStringOrEmpty, normalizeOptionalString } from "./string-coerce.ts";

const CHAT_SPACES_STORAGE_KEY = "openclaw:chat-spaces:v1";

type ChatSpaceMap = Record<string, string>;

function readChatSpaces(): ChatSpaceMap {
  try {
    const raw = getSafeLocalStorage()?.getItem(CHAT_SPACES_STORAGE_KEY);
    if (!raw) {
      return {};
    }
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const result: ChatSpaceMap = {};
    for (const [key, value] of Object.entries(parsed)) {
      const normalizedKey = key.trim();
      const normalizedValue = normalizeOptionalString(value);
      if (!normalizedKey || !normalizedValue) {
        continue;
      }
      result[normalizedKey] = normalizedValue;
    }
    return result;
  } catch {
    return {};
  }
}

function writeChatSpaces(next: ChatSpaceMap) {
  try {
    const storage = getSafeLocalStorage();
    if (!storage) {
      return;
    }
    if (Object.keys(next).length === 0) {
      storage.removeItem(CHAT_SPACES_STORAGE_KEY);
      return;
    }
    storage.setItem(CHAT_SPACES_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Ignore persistence failures and keep the UI usable.
  }
}

export function resolveChatSpace(sessionKey: string, sessionSpace?: string | null): string | null {
  const explicit = normalizeOptionalString(sessionSpace);
  if (explicit) {
    return explicit;
  }
  const stored = readChatSpaces()[sessionKey];
  return normalizeOptionalString(stored) ?? null;
}

export function setChatSpace(sessionKey: string, value: string | null | undefined) {
  const trimmedKey = sessionKey.trim();
  if (!trimmedKey) {
    return;
  }
  const nextValue = normalizeOptionalString(value);
  const current = readChatSpaces();
  if (!nextValue) {
    if (!(trimmedKey in current)) {
      return;
    }
    const next = { ...current };
    delete next[trimmedKey];
    writeChatSpaces(next);
    return;
  }
  if (current[trimmedKey] === nextValue) {
    return;
  }
  writeChatSpaces({
    ...current,
    [trimmedKey]: nextValue,
  });
}

export function listKnownChatSpaces(
  sessions: Array<{ key: string; space?: string | null | undefined }>,
): string[] {
  const known = new Map<string, string>();
  const add = (value: string | null | undefined) => {
    const normalized = normalizeOptionalString(value);
    if (!normalized) {
      return;
    }
    const key = normalizeLowercaseStringOrEmpty(normalized);
    if (!key || known.has(key)) {
      return;
    }
    known.set(key, normalized);
  };
  for (const session of sessions) {
    add(session.space);
    add(readChatSpaces()[session.key]);
  }
  return Array.from(known.values());
}

export function resetChatSpacesForTest() {
  try {
    getSafeLocalStorage()?.removeItem(CHAT_SPACES_STORAGE_KEY);
  } catch {
    // Ignore storage failures in tests too.
  }
}
