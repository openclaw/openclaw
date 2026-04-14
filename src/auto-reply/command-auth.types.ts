import type { ChannelId } from "../channels/plugins/channel-id.types.js";

/**
 * Trusted channel-to-core command auth facts for a single inbound turn.
 * When present, these outcomes are authoritative for command authorization only.
 * Core still derives generic sender identity and message context from MsgContext.
 */
export type ChannelResolvedCommandAuthorization = {
  ownerList: string[];
  senderIsOwner: boolean;
  isAuthorizedSender: boolean;
};

export type CommandAuthorization = {
  providerId?: ChannelId;
  ownerList: string[];
  senderId: string;
  senderIsOwner: boolean;
  isAuthorizedSender: boolean;
  from?: string;
  to?: string;
};
