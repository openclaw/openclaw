import { buildConversationRef } from "../../routing/conversation-ref.js";
import { normalizeSessionDeliveryState } from "../../utils/delivery-context.shared.js";
import type { SessionEntry } from "./types.js";

export const conversationRef = buildConversationRef({
  channel: "reef",
  accountId: "default",
  kind: "direct",
  peerId: "peer-agent",
});
export function conversationEntry(sessionId: string, updatedAt: number): SessionEntry {
  return {
    sessionId,
    updatedAt,
    chatType: "direct",
    delivery: normalizeSessionDeliveryState({
      context: { channel: "reef", accountId: "default", to: "reef:peer-agent" },
      origin: { provider: "reef", accountId: "default", nativeDirectUserId: "peer-agent" },
    }),
  };
}
