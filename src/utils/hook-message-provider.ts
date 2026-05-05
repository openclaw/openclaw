import { parseAgentSessionKey } from "../sessions/session-key-utils.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import { resolveGatewayMessageChannel } from "./message-channel.js";

const SESSION_CONVERSATION_KINDS = new Set(["direct", "dm", "group", "channel"]);

function hasScopedConversationShape(parts: string[]): boolean {
  if (parts.length < 3) {
    return false;
  }
  if (SESSION_CONVERSATION_KINDS.has(parts[1] ?? "")) {
    return true;
  }
  return parts.length >= 4 && SESSION_CONVERSATION_KINDS.has(parts[2] ?? "");
}

export function inferHookMessageProviderFromSessionKey(
  sessionKey?: string | null,
): string | undefined {
  const rest = parseAgentSessionKey(sessionKey)?.rest;
  if (!rest) {
    return undefined;
  }
  const parts = rest
    .split(":")
    .map((part) => part.trim())
    .filter(Boolean);
  const head = parts[0];
  if (!head) {
    return undefined;
  }
  if (!hasScopedConversationShape(parts)) {
    return undefined;
  }
  return resolveGatewayMessageChannel(head);
}

export function resolveHookMessageProvider(params: {
  sessionKey?: string | null;
  provider?: string | null;
}): string | undefined {
  const explicitProvider = normalizeOptionalString(params.provider);
  const normalized = resolveGatewayMessageChannel(explicitProvider);
  if (normalized) {
    return normalized;
  }
  if (explicitProvider) {
    return explicitProvider;
  }
  return inferHookMessageProviderFromSessionKey(params.sessionKey);
}
