import { normalizeConversationText } from "../../acp/conversation-id.js";
import { parseAgentSessionKey } from "../../routing/session-key.js";

export function parseDiscordParentChannelFromSessionKey(raw: unknown): string | undefined {
  const sessionKey = normalizeConversationText(raw);
  if (!sessionKey) {
    return undefined;
  }
  const scoped = parseAgentSessionKey(sessionKey)?.rest ?? sessionKey.toLowerCase();
  const match = scoped.match(/(?:^|:)channel:([^:]+)$/);
  if (!match?.[1]) {
    return undefined;
  }
  return match[1];
}
