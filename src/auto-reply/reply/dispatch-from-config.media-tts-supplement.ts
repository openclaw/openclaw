import { resolveOutboundMediaUrls } from "openclaw/plugin-sdk/reply-payload";
import { hasNonAudioMediaReference } from "../../media/audio.js";
import { mergeDeferredFinalText } from "../../tts/captioned-final.js";
import {
  getReplyPayloadMetadata,
  isReplyPayloadTtsSupplement,
  setReplyPayloadMetadata,
  type ReplyPayload,
} from "../reply-payload.js";

/**
 * Carries the speech decision and the delivery guard onto the synthesized supplement,
 * and nothing else.
 *
 * The line runs between a guard and a claim. `sessionWriterDeliveryAuthority` is a
 * guard: it says which writer may still speak for this session, and dropping it would
 * let audio derived from a replaced writer reach the channel — an absent authority
 * reads as "authorized" at every check. The ownership fields are claims — the
 * transcript row, the delivery completion, the pending-final receipt — and they belong
 * to the visible message alone; a second message must never claim them.
 */
export function withInheritedSupplementMetadata(
  payload: ReplyPayload,
  source: ReplyPayload,
): ReplyPayload {
  const metadata = getReplyPayloadMetadata(source);
  if (!metadata) {
    return payload;
  }
  return setReplyPayloadMetadata(payload, {
    ...(metadata.tts ? { tts: metadata.tts } : {}),
    ...(metadata.ttsExplicit ? { ttsExplicit: metadata.ttsExplicit } : {}),
    ...(metadata.commandReply ? { commandReply: metadata.commandReply } : {}),
    ...(metadata.sessionWriterDeliveryAuthority
      ? {
          sessionWriterDeliveryAuthority: metadata.sessionWriterDeliveryAuthority,
        }
      : {}),
  });
}

/** Legacy `MEDIA:` lines are attachments too, and the core guard refuses to speak them. */
const LEGACY_MEDIA_DIRECTIVE_LINE = /^[ \t]*MEDIA[ \t]*:[ \t]*(.*)$/gim;

/**
 * Speech text for a final that was delivered carrying non-audio media, or "" when the
 * payload is not one. Synthesis overwrites `mediaUrl`, so such finals are delivered
 * silently and their answer is spoken by a separate supplement payload instead.
 *
 * Legacy `MEDIA:` directives are dropped from the returned text: the visible payload
 * keeps them for media resolution, while the spoken copy must not re-trigger the very
 * guard this branch compensates for.
 */
export function resolveMediaFinalTtsText(
  reply: ReplyPayload,
  deferredText?: string,
  preparedText?: string,
): string {
  if (reply.isReasoning === true || reply.isCommentary === true || reply.isError === true) {
    return "";
  }
  // An answer that is itself a voice note already speaks; a supplement would double it.
  if (isReplyPayloadTtsSupplement(reply) || reply.audioAsVoice === true) {
    return "";
  }
  // Speak what delivery prepared, not the raw reply: normalization has already
  // stripped silent/heartbeat tokens and merged deferred block text by then, and a
  // recording cannot be normalized after it is made. An empty prepared text is an
  // answer in itself — the caption was cleared, so there is nothing to say — and only
  // a genuinely absent one falls back to the reply.
  const text =
    preparedText !== undefined
      ? preparedText
      : deferredText
        ? mergeDeferredFinalText(deferredText, reply.text)
        : (reply.text ?? "");
  if (!text.trim()) {
    return "";
  }
  const directiveRefs = [...text.matchAll(LEGACY_MEDIA_DIRECTIVE_LINE)]
    .map((match) => match[1]?.trim() ?? "")
    .filter((ref) => ref.length > 0);
  const mediaRefs = [...resolveOutboundMediaUrls(reply), ...directiveRefs];
  if (mediaRefs.length === 0 || !hasNonAudioMediaReference(mediaRefs)) {
    return "";
  }
  // Stripping a directive line from the middle leaves a hole in the text; collapse
  // it so the spoken copy reads as one piece.
  const spokenText = text
    .replace(LEGACY_MEDIA_DIRECTIVE_LINE, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return spokenText || "";
}
