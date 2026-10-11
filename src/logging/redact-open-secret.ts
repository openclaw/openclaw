import { OPEN_MATCH_CLOSINGS } from "./redact-linear-matchers.js";
import {
  getSecretCaptureStart,
  selectSecretCapture,
  type RedactMatch,
  type RedactMatcher,
} from "./redact-pattern-runtime.js";
import { PEM_REDACT_MATCHER } from "./redact-pem.js";
import { redactSensitiveText } from "./redact.js";

// Closes a private key block left open at the end of a text; the END label need not match BEGIN's.
const PEM_CLOSING = "\n-----END PRIVATE KEY-----";
// Whether a quote opens a secret is asked of the redactor: it gets the key before the quote, the
// separator and quote, then a stand-in value and the closing quote. Each probe stays under
// 512 characters: separator whitespace collapses to one space, as the rules' `\s*` allows, and
// escapes are capped at the redactor's own limit for serialized quotes.
const OPEN_QUOTE_PROBE_CONTEXT_CHARS = 256;
const OPEN_QUOTE_PROBE_SEPARATOR_CHARS = 16;
const OPEN_QUOTE_PROBE_ESCAPE_CHARS = 64;
const OPEN_QUOTE_PROBE_VALUE = "0".repeat(24);
const OPEN_QUOTE_SEPARATOR_CHAR_RE = /[\s:=]/;
const NON_WORD_CHAR_RE = /\W/;
const WHITESPACE_CHAR_RE = /\s/;

/**
 * A secret that `text` ends inside: a default rule's match that runs to the end of `text`, where
 * more text could close or extend it (a private key's END line, an Atlassian token's `=` suffix, a
 * JWT's signature, the `@` after a URL password, the `&key=` after a form value, or the quote that
 * closes a quoted value). Redacting `text` alone can miss it, or mask less of it than redacting a
 * longer text that starts with `text` does. A caller that redacts such a prefix masks from `start`
 * and keeps `closing`, the quote that closes the value. Configured `logging.redactPatterns` are not
 * covered: a configured rule can need any amount of text, so with them the whole value is redacted.
 */
export function findTruncatedSecret(text: string): { start: number; closing: string } | undefined {
  let start = findClosedMatchStart(text, PEM_REDACT_MATCHER, PEM_CLOSING, 0);
  // Token rules allow no whitespace inside a match, so only the run that ends `text` can hold an
  // open one. The character before the run stays: the rules read it as their boundary.
  let runStart = text.length;
  while (runStart > 0 && !WHITESPACE_CHAR_RE.test(text[runStart - 1] ?? "")) {
    runStart--;
  }
  for (const { pattern, closing } of OPEN_MATCH_CLOSINGS) {
    const tokenStart = findClosedMatchStart(text, pattern, closing, Math.max(0, runStart - 1));
    if (tokenStart !== undefined && tokenStart < (start ?? text.length)) {
      start = tokenStart;
    }
  }
  const tokenStart = start;
  let open = start === undefined ? undefined : { start, closing: "" };
  // An open quoted value holds no closing quote, so it follows the last quote of its kind. A
  // quote before the last line break is probed with a value that crosses a line, which only
  // rules for values spanning lines (JSON strings) mask.
  const lineStart = Math.max(text.lastIndexOf("\n"), text.lastIndexOf("\r")) + 1;
  for (const quote of ['"', "'", "`"]) {
    const quoteIndex = text.lastIndexOf(quote);
    if (quoteIndex < 0) {
      continue;
    }
    // An escaped quote closes with the same escape.
    let escapeStart = quoteIndex;
    while (escapeStart > 0 && text[escapeStart - 1] === "\\") {
      escapeStart--;
    }
    // A quote inside an open secret is masked with it, unless the secret opens with the quote
    // (`api_key="...` reads as a form value too): masking the quoted value keeps its closing quote,
    // so a suffix after the mask does not read as the rest of the value.
    if (
      quoteIndex + 1 >= (open?.start ?? text.length) &&
      (escapeStart !== tokenStart || quoteIndex + 1 >= text.length)
    ) {
      continue;
    }
    let separatorStart = escapeStart;
    while (
      separatorStart > 0 &&
      OPEN_QUOTE_SEPARATOR_CHAR_RE.test(text[separatorStart - 1] ?? "")
    ) {
      separatorStart--;
    }
    const escapes = Math.min(quoteIndex - escapeStart, OPEN_QUOTE_PROBE_ESCAPE_CHARS);
    const closing = `${"\\".repeat(escapes)}${quote}`;
    const separator = text
      .slice(separatorStart, escapeStart)
      .replace(/\s+/g, " ")
      .slice(-OPEN_QUOTE_PROBE_SEPARATOR_CHARS);
    // Start the key context on a non-word character, so the probe's start adds no word boundary
    // the text lacks: a rule anchored there could take this quote as its closing one. A context
    // that is one word throughout keeps its cut.
    let keyStart = Math.max(0, separatorStart - OPEN_QUOTE_PROBE_CONTEXT_CHARS);
    if (keyStart > 0) {
      const wordEnd = text.slice(keyStart - 1, separatorStart).search(NON_WORD_CHAR_RE);
      keyStart += wordEnd < 0 ? 0 : wordEnd - 1;
    }
    const key = text.slice(keyStart, separatorStart);
    const value = `${quoteIndex < lineStart ? "\n" : ""}${OPEN_QUOTE_PROBE_VALUE}${closing}`;
    // Only the stand-in's own position counts: the key context may hold the same characters.
    if (!redactSensitiveText(`${key}${separator}${closing}${value}`).endsWith(value)) {
      open = { start: quoteIndex + 1, closing };
    }
  }
  return open;
}

/**
 * Where the secret starts in a match of `pattern` over `text` from `from` that needs `closing`
 * appended after it: one that runs into the closing, or one that ends where `text` does and only
 * matches with the closing after it (a rule that checks what follows its match).
 */
function findClosedMatchStart(
  text: string,
  pattern: RedactMatcher,
  closing: string,
  from: number,
): number | undefined {
  const tail = text.slice(from);
  const input = `${tail}${closing}`;
  for (const match of pattern.exec(input)) {
    const end = match.offset + match.match.length;
    if (match.offset >= tail.length || end < tail.length) {
      continue;
    }
    if (end === tail.length && holdsMatch(pattern, tail, match)) {
      return undefined;
    }
    const selected = selectSecretCapture(match.match, match.groups);
    return (
      from +
      match.offset +
      getSecretCaptureStart(pattern, input, match.match, match.offset, selected)
    );
  }
  return undefined;
}

function holdsMatch(pattern: RedactMatcher, text: string, match: RedactMatch): boolean {
  for (const own of pattern.exec(text)) {
    if (own.offset >= match.offset) {
      return own.offset === match.offset && own.match === match.match;
    }
  }
  return false;
}
