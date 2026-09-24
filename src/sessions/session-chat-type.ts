import { getBootstrapChannelPlugin } from "../channels/plugins/bootstrap-registry.js";
import {
  deriveSessionChatTypeFromKey,
  type SessionKeyChatType,
} from "./session-chat-type-shared.js";

// Session chat-type derivation first uses generic key parsing, then falls back
// to bootstrap channel plugins for legacy platform-specific session keys.
function collectLegacyChatTypeCandidatePluginIds(scopedSessionKey: string): string[] {
  const ids = new Set<string>();
  const firstToken = scopedSessionKey.split(":").find(Boolean);
  if (firstToken) {
    ids.add(firstToken);
  }
  // Historical WhatsApp group keys can be bare JIDs without a channel prefix.
  if (scopedSessionKey.includes("@g.us")) {
    ids.add("whatsapp");
  }
  return Array.from(ids);
}

export function deriveSessionChatType(sessionKey: string | undefined | null): SessionKeyChatType {
  return deriveSessionChatTypeFromKey(sessionKey, [
    (scopedSessionKey) => {
      for (const pluginId of collectLegacyChatTypeCandidatePluginIds(scopedSessionKey)) {
        const deriveLegacySessionChatType =
          getBootstrapChannelPlugin(pluginId)?.messaging?.deriveLegacySessionChatType;
        const derived = deriveLegacySessionChatType?.(scopedSessionKey);
        if (derived) {
          return derived;
        }
      }
      return undefined;
    },
  ]);
}
