import type { MessageReceipt } from "../../channels/message/types.js";
import type { ChannelId } from "../../channels/plugins/channel-id.types.js";

export type OutboundReceiptConfirmationSource =
  | "current_session_visible"
  | "manual_operator_receipt";

export type OutboundDeliveryConfirmation = {
  source: OutboundReceiptConfirmationSource;
  status: "confirmed" | "visible" | "received";
};

export type OutboundDeliveryProjection = {
  providerAccepted?: boolean;
  acknowledged?: boolean;
  confirmation?: OutboundDeliveryConfirmation;
};

export type OutboundVisibilityReceipt = {
  currentSessionVisible?: boolean;
  userVisible?: boolean;
  receiptId?: string;
};

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
  /** Delivery status is split from receipt/ACK evidence. Provider acceptance alone is not acknowledgement. */
  delivery?: OutboundDeliveryProjection;
  // Channel docking: stash channel-specific fields here to avoid core type churn.
  meta?: Record<string, unknown>;
};
