/** Decides when cron heartbeat acknowledgements should stay out of visible delivery. */
import { hasOutboundReplyContent } from "openclaw/plugin-sdk/reply-payload";
import { stripHeartbeatToken } from "../auto-reply/heartbeat.js";

type HeartbeatDeliveryPayload = {
  text?: string;
  mediaUrl?: string;
  mediaUrls?: string[];
  presentation?: unknown;
  interactive?: unknown;
  channelData?: unknown;
};

/** Returns whether delivery output contains only heartbeat acknowledgement text. */
export function shouldSkipHeartbeatOnlyDelivery(
  payloads: HeartbeatDeliveryPayload[],
  ackMaxChars: number,
): boolean {
  if (payloads.length === 0) {
    return true;
  }
  const hasAnyNonTextContent = payloads.some((payload) =>
    hasOutboundReplyContent({ ...payload, text: undefined }, { trimText: true }),
  );
  if (hasAnyNonTextContent) {
    return false;
  }
  // Only the final deliverable decides whether a heartbeat acknowledgement is
  // terminal; earlier acknowledgements must not hide the completed result.
  for (let index = payloads.length - 1; index >= 0; index -= 1) {
    const payload = payloads[index];
    if (!payload || !hasOutboundReplyContent(payload, { trimText: true })) {
      continue;
    }
    return stripHeartbeatToken(payload.text, {
      mode: "heartbeat",
      maxAckChars: ackMaxChars,
    }).shouldSkip;
  }
  return true;
}
