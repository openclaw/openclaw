import type {
  OutboundDeliveryQueuePolicy,
  OutboundPayloadDeliverySuppressionReason,
} from "../../infra/outbound/deliver-types.js";
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

/** Durable delivery queue intent recorded when a reply is deferred. */
export type ChannelDeliveryIntent = {
  id: string;
  kind: "outbound_queue";
  queuePolicy: OutboundDeliveryQueuePolicy;
};

/** Result returned after delivering one channel reply payload. */
export type ChannelDeliveryResult = ChannelDeliveryOutcome & {
  deliveryIntent?: ChannelDeliveryIntent;
  /** Intentional no-send outcome after payload policy or modifying hooks settle. */
  suppression?: {
    reason: OutboundPayloadDeliverySuppressionReason | "channel_transform" | "no_visible_result";
    cancelReason?: string;
    metadata?: Record<string, unknown>;
  };
  /** Same-payload native settlement; resolved fields override this result before observation. */
  finalization?: Promise<ChannelDeliveryOutcome>;
};
