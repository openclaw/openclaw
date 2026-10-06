// Transcript mirroring turns outbound text/media notifications into compact transcript text.
import path from "node:path";

export type SessionTranscriptDeliveryMirror =
  | {
      kind: "channel-final";
      sourceMessageId?: string;
    }
  | {
      kind: "channel-final-suppressed";
      reason: "stale-foreground";
      sourceMessageId?: string;
    };

function extractFileNameFromMediaUrl(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  // Media transcript mirrors use stable filenames instead of raw URLs with tokens/query strings.
  const cleaned = trimmed.split(/[?#]/u, 1)[0] ?? trimmed;
  const parsed = URL.parse(cleaned);
  if (!parsed) {
    const base = path.basename(cleaned);
    return base && base !== "/" && base !== "." ? base : null;
  }
  // Data URLs carry inline bytes, not a filename suitable for transcript text.
  const base = parsed.protocol === "data:" ? "" : path.basename(parsed.pathname);
  if (!base) {
    return null;
  }
  try {
    // Decode display names when possible, but tolerate malformed percent escapes from providers.
    return decodeURIComponent(base);
  } catch {
    return base;
  }
}

/** Resolves compact text to mirror into session transcripts for text or media messages. */
export function resolveMirroredTranscriptText(params: {
  text?: string;
  mediaUrls?: string[];
}): string | null {
  const mediaUrls = params.mediaUrls?.filter((url) => url && url.trim()) ?? [];
  const trimmedText = params.text?.trim() ?? "";
  if (mediaUrls.length > 0) {
    const names = mediaUrls
      .map((url) => extractFileNameFromMediaUrl(url))
      .filter((name): name is string => Boolean(name && name.trim()));
    const mediaText = names.length > 0 ? names.join(", ") : "media";
    return trimmedText ? `${trimmedText}\n${mediaText}` : mediaText;
  }

  return trimmedText || null;
}
