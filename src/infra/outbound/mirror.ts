import type { SessionTranscriptDeliveryMirror } from "../../config/sessions/transcript.js";

/**
 * Transcript append data emitted after an outbound send completes.
 */
export type OutboundMirror = {
  sessionKey: string;
  agentId?: string;
  text?: string;
  mediaUrls?: string[];
  idempotencyKey?: string;
  expectedSessionId?: string;
  deliveryMirror?: SessionTranscriptDeliveryMirror;
  /** Updates a durable intent in place; marker-only is safe during queue recovery. */
  deliveryMirrorUpdateMode?: "marker-only" | "replace";
};

/**
 * Delivery-layer mirror data with optional group/channel correlation metadata.
 */
export type DeliveryMirror = OutboundMirror & {
  /** Whether this message is being sent in a group/channel context */
  isGroup?: boolean;
  /** Group or channel identifier for correlation with received events */
  groupId?: string;
};
