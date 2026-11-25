// System messages use a stable prefix so generated system events can be
// identified without extra metadata in plain chat transcripts.
export const SYSTEM_MARK = "⚙️";

/** Return true when text already carries the system-message prefix. */
export function hasSystemMark(text: string): boolean {
  return text.trim().startsWith(SYSTEM_MARK);
}

/** Prefix non-empty text as a system message without double-prefixing. */
export function prefixSystemMessage(text: string): string {
  const normalized = text.trim();
  if (!normalized || normalized.startsWith(SYSTEM_MARK)) {
    return normalized;
  }
  return `${SYSTEM_MARK} ${normalized}`;
}
