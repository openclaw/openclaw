import { getBootstrapChannelPlugin } from "../channels/plugins/bootstrap-registry.js";
import {
  deriveSessionChatTypeFromKey,
  type SessionKeyChatType,
} from "./session-chat-type-shared.js";

export function deriveSessionChatType(sessionKey: string | undefined | null): SessionKeyChatType {
  return deriveSessionChatTypeFromKey(sessionKey, [
    (scopedSessionKey) => {
      const ids = new Set<string>();
      const firstToken = scopedSessionKey.split(":").find(Boolean);
      if (firstToken) {
        ids.add(firstToken);
      }
      // Historical WhatsApp group keys can be bare JIDs without a channel prefix.
      if (scopedSessionKey.includes("@g.us")) {
        ids.add("whatsapp");
      }
      for (const pluginId of ids) {
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
