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
  const text = readStringValue(payload.text);
  const mediaUrls = Array.isArray(payload.mediaUrls)
    ? payload.mediaUrls.filter(
        (entry): entry is string => typeof entry === "string" && entry.length > 0,
      )
    : undefined;
  const mediaUrl = readStringValue(payload.mediaUrl);
  const presentation = asOptionalRecord(
    payload.presentation,
  ) as OutboundReplyPayload["presentation"];
  const presentationTextMode = payload.presentationTextMode === "fallback" ? "fallback" : undefined;
  const interactive = asOptionalRecord(payload.interactive) as OutboundReplyPayload["interactive"];
  const channelData = asOptionalRecord(payload.channelData) as OutboundReplyPayload["channelData"];
  const sensitiveMedia = payload.sensitiveMedia === true ? true : undefined;
  const replyToId = readStringValue(payload.replyToId);
  const location = normalizeOutboundLocation(payload.location);
  const videoAsNote = payload.videoAsNote === true ? true : undefined;
  return {
    text,
    mediaUrls,
    mediaUrl,
    presentation,
    ...(presentationTextMode ? { presentationTextMode } : {}),
    interactive,
    channelData,
    sensitiveMedia,
    replyToId,
    ...(location ? { location } : {}),
    ...(videoAsNote ? { videoAsNote: true } : {}),
  };
}
