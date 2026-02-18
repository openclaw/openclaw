/**
 * Fuzzy "ok" detection for post-compaction verification gate (Issue #90).
 *
 * Accepts common variants of the user confirming they've read the compaction
 * summary and are ready to resume.
 */

const COMPACTION_ACK_PATTERNS: RegExp[] = [
  /^ok$/i,
  /^okay$/i,
  /^ok\s+go$/i,
  /^looks?\s+good$/i,
  /^lgtm$/i,
  /^go\s+ahead$/i,
  /^continue$/i,
  /^resume$/i,
  /^proceed$/i,
  /^sure$/i,
  /^yes$/i,
  /^yep$/i,
  /^yup$/i,
  /^yeah$/i,
  /^got\s+it$/i,
  /^do\s+it$/i,
];

/**
 * Returns true if the given text is a recognized compaction ack.
 * Expects a trimmed, lowercased string (or trims/lowercases internally).
 */
export function isCompactionAck(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  return COMPACTION_ACK_PATTERNS.some((pat) => pat.test(normalized));
}
