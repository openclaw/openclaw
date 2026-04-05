import { listBootstrapChannelPlugins } from "../channels/plugins/bootstrap-registry.js";
import { parseAgentSessionKey } from "./session-key-utils.js";

export type SessionKeyChatType = "direct" | "group" | "channel" | "unknown";

function deriveBuiltInLegacySessionChatType(
  scopedSessionKey: string,
): SessionKeyChatType | undefined {
  if (/^group:[^:]+$/.test(scopedSessionKey)) {
    return "group";
  }
  if (/^[0-9]+(?:-[0-9]+)*@g\.us$/.test(scopedSessionKey)) {
    return "group";
  }
  if (/^whatsapp:(?!.*:group:).+@g\.us$/.test(scopedSessionKey)) {
    return "group";
  }
  if (/^discord:(?:[^:]+:)?guild-[^:]+:channel-[^:]+$/.test(scopedSessionKey)) {
    return "channel";
  }
  return undefined;
}

/**
 * Best-effort chat-type extraction from session keys across canonical and legacy formats.
 */
export function deriveSessionChatType(sessionKey: string | undefined | null): SessionKeyChatType {
  const raw = (sessionKey ?? "").trim().toLowerCase();
  if (!raw) {
    return "unknown";
  }
  const scoped = parseAgentSessionKey(raw)?.rest ?? raw;
  const tokens = new Set(scoped.split(":").filter(Boolean));
  if (tokens.has("group")) {
    return "group";
  }
  if (tokens.has("channel")) {
    return "channel";
  }
  if (tokens.has("direct") || tokens.has("dm")) {
    return "direct";
  }
  const builtInLegacy = deriveBuiltInLegacySessionChatType(scoped);
  if (builtInLegacy) {
    return builtInLegacy;
  }
  for (const plugin of listBootstrapChannelPlugins()) {
    const derived = plugin.messaging?.deriveLegacySessionChatType?.(scoped);
    if (derived) {
      return derived;
    }
  }
  return "unknown";
}
