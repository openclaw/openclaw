import { normalizeOptionalStringifiedId } from "@openclaw/normalization-core/string-coerce";
import { normalizeMessageChannel } from "./message-channel.js";

export type ConversationTargetParams = {
  channel?: string;
  conversationId?: string | number;
  parentConversationId?: string | number;
};

export function normalizeConversationTargetParams(params: ConversationTargetParams): {
  channel?: string;
  conversationId?: string;
  parentConversationId?: string;
} {
  const channel =
    typeof params.channel === "string"
      ? (normalizeMessageChannel(params.channel) ?? params.channel.trim())
      : undefined;
  const conversationId = normalizeOptionalStringifiedId(params.conversationId);
  const parentConversationId = normalizeOptionalStringifiedId(params.parentConversationId);
  return { channel, conversationId, parentConversationId };
}
