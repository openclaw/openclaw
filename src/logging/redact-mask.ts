import { sliceUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { RedactionEdit } from "./redact-edit-composition.js";

const DEFAULT_REDACT_MIN_LENGTH = 18;
const DEFAULT_REDACT_KEEP_START = 6;
const DEFAULT_REDACT_KEEP_END = 4;
const SECRET_VALUE_TRAILING_DELIMITER_RE = /(["'`,;)}\]]+)$/u;
const SECRET_VALUE_SUFFIX_RE = /^["'`,;)}\]]*$/u;
const SECRET_VALUE_QUOTE_CHARS = new Set(['"', "'", "`"]);
// What a JSON string's closing quote is followed by, once whitespace is skipped.
const JSON_STRING_TERMINATOR_FOLLOWERS = new Set([",", "}", "]", ":"]);
const JSON_WHITESPACE_CHARS = new Set([" ", "\t", "\n", "\r"]);

export function maskToken(token: string): string {
  if (token.length < DEFAULT_REDACT_MIN_LENGTH) {
    return "***";
  }
  const start = sliceUtf16Safe(token, 0, DEFAULT_REDACT_KEEP_START);
  const end = sliceUtf16Safe(token, -DEFAULT_REDACT_KEEP_END);
  return `${start}…${end}`;
}

export function splitSecretValueForMask(token: string) {
  const openingQuote = token[0] ?? "";
  const contentStart = SECRET_VALUE_QUOTE_CHARS.has(openingQuote) ? 1 : 0;
  if (contentStart) {
    const closingQuoteIndex = token.lastIndexOf(openingQuote);
    if (closingQuoteIndex > 0) {
      const suffix = token.slice(closingQuoteIndex + 1);
      if (SECRET_VALUE_SUFFIX_RE.test(suffix)) {
        return {
          maskable: token.slice(1, closingQuoteIndex),
          suffix,
          maskStart: 0,
          maskEnd: closingQuoteIndex + 1,
        };
      }
    }
  }

  const content = token.slice(contentStart);
  const trailingDelimiter = content.match(SECRET_VALUE_TRAILING_DELIMITER_RE)?.[1] ?? "";
  const maskable =
    trailingDelimiter && trailingDelimiter.length < content.length
      ? content.slice(0, -trailingDelimiter.length)
      : content;
  return {
    maskable,
    suffix: maskable === content ? "" : trailingDelimiter,
    maskStart: 0,
    maskEnd: contentStart + maskable.length,
  };
}

export function splitFormAwareCredentialValue(token: string): { secret: string; suffix: string } {
  const pairBoundary = token.search(/&[A-Za-z_][A-Za-z0-9_.-]*=/u);
  return pairBoundary < 0
    ? { secret: token, suffix: "" }
    : { secret: token.slice(0, pairBoundary), suffix: token.slice(pairBoundary) };
}

export function maskSecretValue(token: string): string {
  const { maskable, suffix } = splitSecretValueForMask(token);
  return `${maskToken(maskable)}${suffix}`;
}

/**
 * Ends a serialized-context edit at the string that encloses it.
 *
 * A log record is serialized to JSON before the preparation rules run on it, so
 * a `key=value` at the end of a message sees the record's remaining fields as
 * part of its value: `[^&\s<>]*` stops at a separator, and `"` is not one.
 * Masking that span reached past the message and rewrote the next field, turning
 * `"level":"info"` into `"***":"***"` and dropping the severity every log
 * consumer reads (this predates camelCase recognition: `?token=` and
 * `?client_secret=` at the end of a message did it too).
 *
 * A string's own quotes arrive escaped, so an unescaped `"` followed by `,`,
 * `}`, `]`, `:` or the end of the text closes the enclosing string and ends the
 * value. A quote anywhere else stays inside the value, which keeps whole-text
 * callers masking a value that merely contains one.
 */
function enclosingStringEnd(text: string, start: number, end: number): number {
  for (let index = start; index < end; index += 1) {
    const char = text[index];
    if (char === "\\") {
      // The escaped character belongs to the string, quotes included.
      index += 1;
      continue;
    }
    if (char !== '"') {
      continue;
    }
    // Walk the gap rather than slicing it: a long value may hold many quotes,
    // and a slice per quote would make this quadratic.
    let follower = index + 1;
    while (follower < text.length && JSON_WHITESPACE_CHARS.has(text[follower] ?? "")) {
      follower += 1;
    }
    if (follower === text.length || JSON_STRING_TERMINATOR_FOLLOWERS.has(text[follower] ?? "")) {
      return index;
    }
  }
  return end;
}

/** Re-ends every edit at its enclosing string, dropping any that cannot start inside one. */
export function clampEditsToEnclosingString(
  text: string,
  edits: readonly RedactionEdit[],
  mask: (maskable: string) => string,
): RedactionEdit[] {
  const clamped: RedactionEdit[] = [];
  for (const edit of edits) {
    const stringEnd = enclosingStringEnd(text, edit.start, edit.end);
    if (stringEnd === edit.end) {
      clamped.push(edit);
      continue;
    }
    if (stringEnd <= edit.start) {
      continue;
    }
    const { maskable, maskEnd } = splitSecretValueForMask(text.slice(edit.start, stringEnd));
    if (maskEnd <= 0) {
      continue;
    }
    clamped.push({ start: edit.start, end: edit.start + maskEnd, replacement: mask(maskable) });
  }
  return clamped;
}
