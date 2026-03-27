import { parseAgentSessionKey } from "../routing/session-key.js";

const HOOK_RESERVED_SESSION_KEY_PREFIXES = ["subagent:", "acp:", "cron:"] as const;

function resolveSessionKey(raw: string | undefined): string | undefined {
  const value = raw?.trim();
  return value ? value : undefined;
}

function normalizeHookValidatedSessionKey(raw: string | undefined): string | undefined {
  let value = resolveSessionKey(raw);
  while (value) {
    const parsed = parseAgentSessionKey(value);
    if (!parsed) {
      return value;
    }
    value = parsed.rest;
  }
  return undefined;
}

export function resolveReservedHookSessionKeyPrefix(
  sessionKey: string | undefined,
): string | undefined {
  const normalized = normalizeHookValidatedSessionKey(sessionKey)?.toLowerCase();
  if (!normalized) {
    return undefined;
  }
  return HOOK_RESERVED_SESSION_KEY_PREFIXES.find((prefix) => normalized.startsWith(prefix));
}
