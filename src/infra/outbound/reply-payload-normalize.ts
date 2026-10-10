import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { readStringValue } from "@openclaw/normalization-core/string-coerce";
import type { ReplyPayload as InternalReplyPayload } from "../../auto-reply/reply-payload.js";
import { normalizeOutboundLocation } from "../../channels/location.js";

/** Outbound fields accepted from loose producers. */
export type OutboundReplyPayload = Pick<
  InternalReplyPayload,
  | "text"
  | "mediaUrls"
  | "mediaUrl"
  | "presentation"
  | "presentationTextMode"
  | "interactive"
  | "channelData"
  | "sensitiveMedia"
  | "replyToId"
  | "location"
  | "videoAsNote"
>;

/** Extract the supported outbound reply fields from loose tool or agent payload objects. */
export function normalizeOutboundReplyPayloadCore(
  payload: Record<string, unknown>,
): OutboundReplyPayload {
  const result: OutboundReplyPayload = {
    text: readStringValue(payload.text),
    mediaUrls: Array.isArray(payload.mediaUrls)
      ? payload.mediaUrls.filter(
          (entry): entry is string => typeof entry === "string" && entry.length > 0,
        )
      : undefined,
    mediaUrl: readStringValue(payload.mediaUrl),
    presentation: asOptionalRecord(payload.presentation) as OutboundReplyPayload["presentation"],
    ...(payload.presentationTextMode === "fallback" ? { presentationTextMode: "fallback" } : {}),
    interactive: asOptionalRecord(payload.interactive) as OutboundReplyPayload["interactive"],
    channelData: asOptionalRecord(payload.channelData) as OutboundReplyPayload["channelData"],
    sensitiveMedia: payload.sensitiveMedia === true ? true : undefined,
    replyToId: readStringValue(payload.replyToId),
  };
  const location = normalizeOutboundLocation(payload.location);
  if (location) {
    result.location = location;
  }
  if (payload.videoAsNote === true) {
    result.videoAsNote = true;
  }
  return result;
}
