import { markReplyPayloadForSourceSuppressionDelivery } from "../reply-payload.js";
import type { ReplyPayload } from "../types.js";

export const STRANDED_REPLY_RETRY_MARKER = "stranded-reply-retry";
export const STRANDED_REPLY_DELIVERY_FAILURE_TEXT =
  "I generated a reply but could not deliver it to this chat. Please try again.";

export function buildStrandedReplyDeliveryFailurePayload(): ReplyPayload {
  return markReplyPayloadForSourceSuppressionDelivery({
    text: STRANDED_REPLY_DELIVERY_FAILURE_TEXT,
    isError: true,
    isStatusNotice: true,
  });
}
