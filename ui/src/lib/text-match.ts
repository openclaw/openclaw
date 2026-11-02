import { escapeRegExp } from "../../../src/shared/regexp.ts";

// Preserve source offsets when case folding expands Unicode characters.
// The pattern is literal; callers decide how each matched span is rendered.
export function matchQuery(text: string, query: string): RegExpExecArray | null {
  const needle = query.trim();
  return needle ? new RegExp(escapeRegExp(needle), "iu").exec(text) : null;
}

/**
 * Literal, case-insensitive phrase pattern whose spaces match any whitespace
 * run, so a phrase can cross rendered line and block boundaries.
 */
export function phraseQueryPattern(query: string): RegExp | null {
  const words = query.trim().normalize("NFC").split(/\s+/u).filter(Boolean);
  return words.length > 0 ? new RegExp(words.map(escapeRegExp).join("\\s+"), "giu") : null;
}
