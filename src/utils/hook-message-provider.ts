import { parseAgentSessionKey } from "../sessions/session-key-utils.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import { isDeliverableMessageChannel, normalizeMessageChannel } from "./message-channel.js";

const NON_CHANNEL_SESSION_KEY_HEADS = new Set([
  "main",
  "cron",
  "subagent",
  "acp",
  "direct",
  "dm",
  "hook",
  "webhook",
]);

export function inferHookMessageProviderFromSessionKey(
  sessionKey?: string | null,
): string | undefined {
  const rest = parseAgentSessionKey(sessionKey)?.rest;
  if (!rest) {
    return undefined;
  }
  const parts = rest.split(":").filter(Boolean);
  const head = parts[0]?.trim();
  if (!head || parts.length < 3 || NON_CHANNEL_SESSION_KEY_HEADS.has(head)) {
    return undefined;
  }
  const normalized = normalizeMessageChannel(head);
  return normalized && isDeliverableMessageChannel(normalized) ? normalized : undefined;
}

export function resolveHookMessageProvider(params: {
  sessionKey?: string | null;
  provider?: string | null;
}): string | undefined {
  const explicitProvider = normalizeOptionalString(params.provider);
  const normalized = normalizeMessageChannel(explicitProvider);
  if (normalized && isDeliverableMessageChannel(normalized)) {
    return normalized;
  }
  if (explicitProvider) {
    return explicitProvider;
  }
  return inferHookMessageProviderFromSessionKey(params.sessionKey);
}
