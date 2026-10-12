import type { SessionTranscriptDeliveryMirror } from "../../config/sessions/transcript-mirror.js";

/** @deprecated Confirmed sends record destination history automatically; removed in the next Plugin SDK major. */
export type DeliveryMirror = {
  sessionKey: string;
  agentId?: string;
  text?: string;
  mediaUrls?: string[];
  idempotencyKey?: string;
  expectedSessionId?: string;
  deliveryMirror?: SessionTranscriptDeliveryMirror;
  isGroup?: boolean;
  groupId?: string;
};
