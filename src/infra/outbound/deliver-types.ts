import type { MessageReceipt } from "../../channels/message/types.js";
import type { ChannelId } from "../../channels/plugins/channel-id.types.js";
import type { OutboundDeliveryProjection } from "./delivery-projection.js";

export type { OutboundDeliveryProjection } from "./delivery-projection.js";

export type OutboundDeliveryResult = {
  channel: Exclude<ChannelId, "none">;
  messageId: string;
  chatId?: string;
  channelId?: string;
  roomId?: string;
  conversationId?: string;
  timestamp?: number;
  toJid?: string;
  pollId?: string;
  receipt?: MessageReceipt;
  /** Provider delivery projection. Provider acceptance alone is not user visibility or read acknowledgement. */
  delivery?: OutboundDeliveryProjection;
  // Channel docking: stash channel-specific fields here to avoid core type churn.
  meta?: Record<string, unknown>;
};
