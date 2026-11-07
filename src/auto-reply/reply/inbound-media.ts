import { normalizeMimeType } from "@openclaw/media-core/mime";
import {
  isMeaningfulMediaFact,
  normalizeMediaFacts,
  type MediaFact,
} from "../../media/media-facts.js";
import type { RuntimeMsgContext as MsgContext } from "../templating.js";

/** Minimal inbound media fields used by media/audio detection. */
type InboundMediaContext = Pick<MsgContext, "media"> & {
  Body?: unknown;
  StickerMediaIncluded?: unknown;
  SkipStickerMediaUnderstanding?: unknown;
  Sticker?: unknown;
};

function meaningfulMedia(ctx: InboundMediaContext) {
  return normalizeMediaFacts(ctx.media).filter(isMeaningfulMediaFact);
}

/** Returns true when the context carries current-turn media or sticker data. */
export function hasInboundMedia(ctx: InboundMediaContext): boolean {
  return Boolean(ctx.StickerMediaIncluded || ctx.Sticker || meaningfulMedia(ctx).length > 0);
}

/** Returns true when current-turn media still needs automatic understanding. */
export function hasInboundMediaForUnderstanding(ctx: InboundMediaContext): boolean {
  if (!ctx.SkipStickerMediaUnderstanding) {
    return hasInboundMedia(ctx);
  }
  return meaningfulMedia(ctx).length > 1;
}

function isAudioMediaFact(media: MediaFact): boolean {
  const type = normalizeMimeType(media.contentType);
  return media.kind === "audio" || type === "audio" || type?.startsWith("audio/") === true;
}

/** Returns true when the current message carries structured audio media facts of its own. */
export function hasInboundAudio(ctx: InboundMediaContext): boolean {
  return normalizeMediaFacts(ctx.media).some((media) => !media.quoted && isAudioMediaFact(media));
}

/** Returns true when any turn media is audio, including media from the replied-to message. */
export function hasAnyInboundAudio(ctx: InboundMediaContext): boolean {
  return normalizeMediaFacts(ctx.media).some(isAudioMediaFact);
}
