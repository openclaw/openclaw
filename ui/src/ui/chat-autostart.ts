import { normalizeOptionalString } from "./string-coerce.ts";
import { generateUUID } from "./uuid.ts";

export const CHAT_AUTOSTART_BOOTSTRAP_PROMPT = "Please introduce yourself to the user.";

const CHAT_AUTOSTART_BOOTSTRAP_VALUES = new Set(["1", "true", "yes", "on", "bootstrap"]);

export type ChatAutostartRequest = {
  idempotencyKey: string;
  prompt: string;
  sessionKey: string | null;
};

export function resolveChatAutostartPrompt(raw: string | null): string | null {
  if (raw == null) {
    return null;
  }
  const normalized = raw.trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  return CHAT_AUTOSTART_BOOTSTRAP_VALUES.has(normalized) ? CHAT_AUTOSTART_BOOTSTRAP_PROMPT : null;
}

export function createChatAutostartRequest(
  prompt: string | null | undefined,
  sessionKey: string | null | undefined,
): ChatAutostartRequest | null {
  const normalizedPrompt = normalizeOptionalString(prompt);
  if (!normalizedPrompt) {
    return null;
  }
  return {
    idempotencyKey: generateUUID(),
    prompt: normalizedPrompt,
    sessionKey: normalizeOptionalString(sessionKey) ?? null,
  };
}

export function resolveChatAutostartRequest(
  raw: string | null,
  sessionKey: string | null | undefined,
): ChatAutostartRequest | null {
  return createChatAutostartRequest(resolveChatAutostartPrompt(raw), sessionKey);
}
