import { escapeRegExp } from "../../../src/shared/regexp.ts";

/**
 * Literal, case-insensitive phrase pattern whose spaces match any whitespace
 * run, so a phrase can cross rendered line and block boundaries.
 */
export function phraseQueryPattern(query: string): RegExp | null {
  const words = query.trim().normalize("NFC").split(/\s+/u).filter(Boolean);
  return words.length > 0 ? new RegExp(words.map(escapeRegExp).join("\\s+"), "giu") : null;
}
