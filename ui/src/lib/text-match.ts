import { escapeRegExp } from "../../../src/shared/regexp.ts";

// Preserve source offsets when case folding expands Unicode characters.
// The pattern is literal; callers decide how each matched span is rendered.
export function matchQuery(text: string, query: string): RegExpExecArray | null {
  const needle = query.trim();
  return needle ? new RegExp(escapeRegExp(needle), "iu").exec(text) : null;
}

/** Case- and accent-insensitive search key. */
export const foldSearchText = (value: string) =>
  value.normalize("NFD").replace(/\p{M}/gu, "").toLocaleLowerCase();

/**
 * Source span of the first foldSearchText match. Folding changes length (Hangul
 * splits into jamo, marks drop), so map through the folded length of each prefix.
 */
export function matchFoldedQuery(text: string, query: string) {
  const needle = foldSearchText(query.trim());
  const index = needle ? foldSearchText(text).indexOf(needle) : -1;
  if (index < 0) {
    return null;
  }
  const foldedLength = (end: number) => foldSearchText(text.slice(0, end)).length;
  let start = 0;
  while (foldedLength(start + 1) <= index) {
    start += 1;
  }
  let end = start;
  while (foldedLength(end) < index + needle.length) {
    end += 1;
  }
  // Trailing marks belong to the last matched character.
  end += /^\p{M}*/u.exec(text.slice(end))![0].length;
  return { start, end };
}

/**
 * Literal, case-insensitive phrase pattern whose spaces match any whitespace
 * run, so a phrase can cross rendered line and block boundaries.
 */
export function phraseQueryPattern(query: string): RegExp | null {
  const words = query.trim().normalize("NFC").split(/\s+/u).filter(Boolean);
  return words.length > 0 ? new RegExp(words.map(escapeRegExp).join("\\s+"), "giu") : null;
}
