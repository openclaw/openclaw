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
  // Only the terminal text decides whether the run stays quiet; an earlier ack
  // must not discard a later report or alert from the same agent turn.
  const terminalPayload = payloads.findLast((payload) => Boolean(payload.text?.trim()));
  if (!terminalPayload) {
    return true;
  }
  return stripHeartbeatToken(terminalPayload.text, {
    mode: "heartbeat",
    maxAckChars: ackMaxChars,
  }).shouldSkip;
}
