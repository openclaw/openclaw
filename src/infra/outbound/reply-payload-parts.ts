import { normalizeStringEntries } from "../../../packages/normalization-core/src/string-normalization.js";
import type { ReplyPayload } from "../../shared/reply-payload.types.js";

/** Derived sendability facts for text/media outbound payload delivery. */
export type SendableOutboundReplyParts = {
  text: string;
  trimmedText: string;
  /** Normalized non-empty media URLs. */
  mediaUrls: string[];
  mediaCount: number;
  hasText: boolean;
  hasMedia: boolean;
  hasContent: boolean;
};

/** Prepared payload entry that keeps source indexing plus reusable projections. */
export type OutboundPayloadPlan = {
  sourceIndex: number;
  payload: ReplyPayload;
  parts: SendableOutboundReplyParts;
  hasPresentation: boolean;
  hasInteractive: boolean;
  hasChannelData: boolean;
};

/** Prefer multi-attachment payloads, then fall back to the legacy single-media field. */
export function resolveOutboundMediaUrls(payload: {
  mediaUrls?: string[];
  mediaUrl?: string;
}): string[] {
  if (payload.mediaUrls?.some((mediaUrl) => mediaUrl.trim())) {
    return payload.mediaUrls;
  }
  return payload.mediaUrl ? [payload.mediaUrl] : [];
}

export function countOutboundMedia(payload: { mediaUrls?: string[]; mediaUrl?: string }): number {
  return resolveOutboundMediaUrls(payload).length;
}

export function hasOutboundMedia(payload: { mediaUrls?: string[]; mediaUrl?: string }): boolean {
  return countOutboundMedia(payload) > 0;
}

export function hasOutboundText(payload: { text?: string }, options?: { trim?: boolean }): boolean {
  const text = options?.trim ? payload.text?.trim() : payload.text;
  return Boolean(text);
}

/** Normalize reply payload text/media into a trimmed, sendable shape for delivery paths. */
export function resolveSendableOutboundReplyParts(
  payload: { text?: string; mediaUrls?: string[]; mediaUrl?: string },
  options?: { text?: string },
): SendableOutboundReplyParts {
  const text = options?.text ?? payload.text ?? "";
  const trimmedText = text.trim();
  const mediaUrls = normalizeStringEntries(resolveOutboundMediaUrls(payload));
  const mediaCount = mediaUrls.length;
  const hasText = Boolean(trimmedText);
  const hasMedia = mediaCount > 0;
  return {
    text,
    trimmedText,
    mediaUrls,
    mediaCount,
    hasText,
    hasMedia,
    hasContent: hasText || hasMedia,
  };
}
