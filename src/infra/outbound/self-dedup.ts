import { normalizeTextForComparison } from "../../agents/pi-embedded-helpers/messaging-dedupe.js";

const MIN_SELF_DEDUP_LENGTH = 20;

/**
 * Detect paragraph-level self-duplication within a single text.
 *
 * Splits on double-newline boundaries and removes duplicate paragraphs
 * (keeping the first occurrence). Returns the deduplicated text, or null
 * if no duplication was found.
 *
 * Short texts (< MIN_SELF_DEDUP_LENGTH) are skipped to avoid false
 * positives on intentional repetition like "ok\n\nok".
 */
export function detectTextSelfDuplication(text: string): string | null {
  if (!text || text.length < MIN_SELF_DEDUP_LENGTH) {
    return null;
  }

  const paragraphs = text.split(/\n\n+/);
  if (paragraphs.length < 2) {
    return null;
  }

  const seen = new Set<string>();
  const deduplicated: string[] = [];
  let foundDuplicate = false;

  for (const paragraph of paragraphs) {
    const normalized = normalizeTextForComparison(paragraph);
    // Keep empty/whitespace-only paragraphs (formatting).
    if (!normalized) {
      deduplicated.push(paragraph);
      continue;
    }
    if (seen.has(normalized)) {
      foundDuplicate = true;
      continue;
    }
    seen.add(normalized);
    deduplicated.push(paragraph);
  }

  return foundDuplicate ? deduplicated.join("\n\n") : null;
}

/**
 * Detect full-text repetition: the text is the same content repeated
 * back-to-back (e.g., streaming concatenation bug where the buffer
 * is appended to itself).
 *
 * Checks whether the first half of the text equals the second half
 * after normalization. Returns the first half (original) if a match
 * is found, or null otherwise.
 */
export function detectFullTextRepetition(text: string): string | null {
  if (!text || text.length < MIN_SELF_DEDUP_LENGTH * 2) {
    return null;
  }

  const trimmed = text.trim();
  if (trimmed.length < MIN_SELF_DEDUP_LENGTH * 2) {
    return null;
  }

  const mid = Math.floor(trimmed.length / 2);
  const firstHalf = trimmed.slice(0, mid);
  const secondHalf = trimmed.slice(mid);

  const normalizedFirst = normalizeTextForComparison(firstHalf);
  const normalizedSecond = normalizeTextForComparison(secondHalf);

  if (normalizedFirst && normalizedFirst === normalizedSecond) {
    return firstHalf.trim();
  }

  return null;
}

/**
 * Apply all self-deduplication heuristics to a text.
 * Returns the cleaned text if any duplication was found, or null if the
 * text is clean.
 *
 * Order: full-text repetition first (more aggressive), then paragraph-level.
 */
export function deduplicateText(text: string): string | null {
  const fullRepetition = detectFullTextRepetition(text);
  if (fullRepetition != null) {
    return fullRepetition;
  }
  return detectTextSelfDuplication(text);
}
