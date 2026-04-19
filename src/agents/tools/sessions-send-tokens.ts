export const ANNOUNCE_SKIP_TOKEN = "ANNOUNCE_SKIP";
export const REPLY_SKIP_TOKEN = "REPLY_SKIP";

const ANNOUNCE_TAG_RE = /<announce>([\s\S]*?)<\/announce>/i;

export function isAnnounceSkip(text?: string) {
  return (text ?? "").trim() === ANNOUNCE_SKIP_TOKEN;
}

export function isReplySkip(text?: string) {
  return (text ?? "").trim() === REPLY_SKIP_TOKEN;
}

export type AnnounceDropReason = "empty_input" | "skip_token" | "untagged" | "empty_tag" | null;

/**
 * Extract the inner content from an `<announce>...</announce>` tagged reply.
 * Returns null if the text is missing, a skip token, or untagged.
 */
export function extractAnnouncePayload(text?: string): string | null {
  if (!text) {
    return null;
  }
  const trimmed = text.trim();
  if (!trimmed || isAnnounceSkip(trimmed)) {
    return null;
  }
  const match = ANNOUNCE_TAG_RE.exec(trimmed);
  if (!match) {
    return null;
  }
  const inner = match[1].trim();
  return inner || null;
}

/** Classify why extractAnnouncePayload returned null — for diagnostics only. */
export function classifyAnnounceDropReason(text?: string): AnnounceDropReason {
  if (!text || !text.trim()) {
    return "empty_input";
  }
  if (isAnnounceSkip(text)) {
    return "skip_token";
  }
  const match = ANNOUNCE_TAG_RE.exec(text.trim());
  if (!match) {
    return "untagged";
  }
  if (!match[1].trim()) {
    return "empty_tag";
  }
  return null; // payload was extracted successfully
}
