import { escapeRegExp } from "../../../src/shared/regexp.ts";

// Preserve source offsets when case folding expands Unicode characters.
// The pattern is literal; callers decide how each matched span is rendered.
export function matchQuery(text: string, query: string): RegExpExecArray | null {
  const needle = query.trim();
  return needle ? new RegExp(escapeRegExp(needle), "iu").exec(text) : null;
}

const foldChar = (char: string) => char.normalize("NFD").replace(/\p{M}/gu, "").toLocaleLowerCase();

/**
 * Literal, case- and accent-insensitive match reported as source offsets.
 * Folding changes length (Hangul splits into jamo, decomposed accents drop),
 * so each folded unit keeps the span of the source character it came from.
 */
export function matchFoldedQuery(
  text: string,
  query: string,
): { start: number; end: number } | null {
  let needle = "";
  for (const char of query.trim()) {
    needle += foldChar(char);
  }
  if (!needle) {
    return null;
  }
  let folded = "";
  const starts: number[] = [];
  const ends: number[] = [];
  let offset = 0;
  for (const char of text) {
    const next = offset + char.length;
    const part = foldChar(char);
    if (part) {
      folded += part;
      starts.push(...Array<number>(part.length).fill(offset));
      ends.push(...Array<number>(part.length).fill(next));
    } else {
      // A dropped mark belongs to the character before it.
      for (let unit = ends.length - 1; unit >= 0 && ends[unit] === offset; unit -= 1) {
        ends[unit] = next;
      }
    }
    offset = next;
  }
  const index = folded.indexOf(needle);
  if (index < 0) {
    return null;
  }
  return { start: starts[index] ?? 0, end: ends[index + needle.length - 1] ?? text.length };
}

/**
 * Literal, case-insensitive phrase pattern whose spaces match any whitespace
 * run, so a phrase can cross rendered line and block boundaries.
 */
export function phraseQueryPattern(query: string): RegExp | null {
  const words = query.trim().normalize("NFC").split(/\s+/u).filter(Boolean);
  return words.length > 0 ? new RegExp(words.map(escapeRegExp).join("\\s+"), "giu") : null;
}
