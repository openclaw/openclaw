import type { InboundSourceModality } from "../../auto-reply/templating.js";
import type { InboundMediaFacts } from "./types.js";

const INBOUND_SOURCE_MODALITIES = new Set([
  "text",
  "voice",
  "audio",
  "image",
  "video",
  "document",
]);

/** Maps one media fact to its source modality ("document" for non-media file types). */
export function resolveInboundSourceModalityForMedia(
  media: InboundMediaFacts | undefined,
): InboundSourceModality | undefined {
  if (!media) {
    return undefined;
  }
  const mediaType = String(media.contentType ?? media.kind ?? "").trim();
  if (!mediaType) {
    return undefined;
  }
  const slash = mediaType.indexOf("/");
  const mediaKind = (slash > 0 ? mediaType.slice(0, slash) : mediaType).toLowerCase();
  if (mediaKind === "application" || mediaKind === "text") {
    return "document";
  }
  return INBOUND_SOURCE_MODALITIES.has(mediaKind) ? (mediaKind as InboundSourceModality) : undefined;
}

/** Derives the current message's source modality from its own media, in list order. */
export function resolveInboundSourceModalityFromOwnMedia(
  media: readonly InboundMediaFacts[] | undefined,
): InboundSourceModality | undefined {
  for (const entry of media ?? []) {
    const modality = resolveInboundSourceModalityForMedia(entry);
    if (modality) {
      return modality;
    }
  }
  return undefined;
}
