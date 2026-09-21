import type { MessageReceipt } from "../message/types.js";

/** Provider-visible delivery facts shared by channel turns and outbound entrypoints. */
export type ChannelDeliveryOutcome = {
  messageIds?: string[];
  receipt?: MessageReceipt;
  threadId?: string;
  replyToId?: string;
  visibleReplySent?: boolean;
  /** Final provider-visible text used for this logical payload's terminal observation. */
  content?: string;
};
