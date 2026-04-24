/**
 * Detect unmatched inline formatting markers (backticks, asterisks, underscores)
 * at chunk boundaries and provide close/reopen strings.
 */

import { parseFenceSpans, type FenceSpan } from "./fences.js";

export type InlineFormatState = {
  /** Unmatched markers in order of appearance, e.g. ["**", "*", "`"] */
  openMarkers: string[];
};

const INLINE_MARKERS = ["***", "**", "*", "___", "__", "_", "``", "`"];

/**
 * Scan text for unmatched inline formatting markers, skipping fenced regions.
 * Returns the markers that are still "open" at the end of the text.
 */
export function scanUnmatchedInlineMarkers(
  text: string,
  fenceSpans?: FenceSpan[],
): InlineFormatState {
  const spans = fenceSpans ?? parseFenceSpans(text);
  const openMarkers: string[] = [];

  let i = 0;
  while (i < text.length) {
    // Skip fenced regions
    const inFence = spans.find((s) => i >= s.start && i < s.end);
    if (inFence) {
      i = inFence.end;
      continue;
    }

    // Skip escaped characters
    if (text[i] === "\\" && i + 1 < text.length) {
      i += 2;
      continue;
    }

    // Try to match markers longest-first
    let matched = false;
    for (const marker of INLINE_MARKERS) {
      if (text.startsWith(marker, i)) {
        // For `_`-based markers: only treat as emphasis if at a word boundary.
        // CommonMark: `_` opens/closes emphasis only when not inside a word.
        // Check both the character before AND after to avoid mangling snake_case.
        if (marker.startsWith("_")) {
          const prev = i > 0 ? text[i - 1] : " ";
          const next = i + marker.length < text.length ? text[i + marker.length] : " ";
          if (/\w/.test(prev) || /\w/.test(next)) {
            // Inside a word - not an emphasis marker, skip just this char
            i++;
            matched = true;
            break;
          }
        }
        const existingIdx = openMarkers.lastIndexOf(marker);
        if (existingIdx !== -1) {
          // Close matching marker
          openMarkers.splice(existingIdx, 1);
        } else {
          openMarkers.push(marker);
        }
        i += marker.length;
        matched = true;
        break;
      }
    }
    if (!matched) {
      i++;
    }
  }

  return { openMarkers };
}

/**
 * Build the closing string for unmatched markers (reverse order).
 */
export function buildInlineClose(state: InlineFormatState): string {
  return [...state.openMarkers].toReversed().join("");
}

/**
 * Build the reopening string for unmatched markers (original order).
 */
export function buildInlineReopen(state: InlineFormatState): string {
  return state.openMarkers.join("");
}
