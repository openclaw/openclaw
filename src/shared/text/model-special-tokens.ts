// Model special token helpers strip model control tokens outside code regions.
import { findCodeRegions } from "./code-regions.js";
import type { TextFilter, TextProjection } from "./text-projection.js";

// Match both ASCII pipe <|...|> and full-width pipe <｜...｜> (U+FF5C) variants.
// Control tokens never contain whitespace; prose operators like `<|` ... `|>` do.
const MODEL_SPECIAL_TOKEN_RE = /<[|｜][^|｜\s]*[|｜]>/g;
// A delta can split the two-character opener, so activation carries one trailing character.
const TOKEN_START_RE = /<[|｜]/;

function findLastPipe(text: string, fromIndex: number): number {
  return Math.max(text.lastIndexOf("|", fromIndex), text.lastIndexOf("｜", fromIndex));
}

// A trailing `<`, `<|body`, or `<|body|` can still become a token when the stream continues.
// The body may itself contain `<`, so the opener is found from its pipes, not the last `<`.
function endsWithIncompleteTokenPrefix(text: string): boolean {
  if (text.endsWith("<")) {
    return true;
  }
  const closePipe = findLastPipe(text, text.length - 1);
  if (closePipe < 1) {
    return false;
  }
  if (closePipe === text.length - 1) {
    const openPipe = findLastPipe(text, closePipe - 1);
    if (openPipe > 0 && text[openPipe - 1] === "<") {
      return true;
    }
    return text[closePipe - 1] === "<";
  }
  if (text[closePipe - 1] !== "<") {
    return false;
  }
  return !/[\s|｜]/.test(text.slice(closePipe + 1));
}

function endsWithCompleteToken(text: string): boolean {
  if (!text.endsWith(">")) {
    return false;
  }
  const closePipe = findLastPipe(text, text.length - 2);
  if (closePipe < 1) {
    return false;
  }
  const openPipe = findLastPipe(text, closePipe - 1);
  return (
    openPipe > 0 &&
    text[openPipe - 1] === "<" &&
    !/[\s|｜]/.test(text.slice(openPipe + 1, closePipe))
  );
}

// A token followed by half of a surrogate pair still has an undecided separator.
function endsWithTokenBeforeIncompleteSurrogate(text: string): boolean {
  return /[\uD800-\uDBFF]$/u.test(text) && endsWithCompleteToken(text.slice(0, -1));
}

/**
 * Strips leaked model control tokens like `<|assistant|>` or full-width pipe variants.
 * Code examples are preserved; remove this when providers stop emitting these tokens.
 *
 * @see https://github.com/openclaw/openclaw/issues/40020
 */
export function stripModelSpecialTokens(text: string): string {
  if (!text) {
    return text;
  }
  MODEL_SPECIAL_TOKEN_RE.lastIndex = 0;
  if (!MODEL_SPECIAL_TOKEN_RE.test(text)) {
    return text;
  }
  MODEL_SPECIAL_TOKEN_RE.lastIndex = 0;

  const codeRegions = findCodeRegions(text);
  let out = "";
  let cursor = 0;
  for (const match of text.matchAll(MODEL_SPECIAL_TOKEN_RE)) {
    const matched = match[0];
    const start = match.index ?? 0;
    const end = start + matched.length;
    out += text.slice(cursor, start);
    if (codeRegions.some((region) => start < region.end && end > region.start)) {
      out += matched;
    } else if (
      // Retained text handles adjacent tokens; two code units preserve astral letters.
      // Keep alternation: Node 26.5's V8 misses astral letters in `$`-anchored `u` classes.
      // A following combining mark stays attached, and punctuation needs no separator.
      /(?:\p{L}|\p{M}|\p{N})$/u.test(out.slice(-2)) &&
      /^[\p{L}\p{N}]/u.test(text.slice(end, end + 2))
    ) {
      out += " ";
    }
    cursor = end;
  }
  out += text.slice(cursor);
  return out;
}

/**
 * Streams the same stripping without re-parsing the settled prefix after a leak. Once a
 * token has appeared, deltas that cannot start or complete one append directly; the
 * canonical transform only runs for an unstable tail, a token-ending separator, a backtick
 * delta, or a fence-capable tilde run that can change whether an earlier token is code-owned.
 */
export function createModelSpecialTokenProjector(): (input: TextProjection) => TextProjection {
  let inputLength = 0;
  let output = "";
  let active = false;
  let activationTail = "";
  let pendingPrefix = false;
  // A removed token at the end decides its separator only once the next character is complete.
  let separatorPending = false;
  // Only a 3+ tilde run can open or close a fence, so a split run carries two characters.
  let tildeCarry = "";

  const projectFull = (text: string, delta: string | null): TextProjection => {
    inputLength = text.length;
    const next = stripModelSpecialTokens(text);
    const nextDelta =
      delta === null ? null : next.startsWith(output) ? next.slice(output.length) : null;
    output = next;
    active ||= TOKEN_START_RE.test(text);
    activationTail = text.slice(-1);
    pendingPrefix = endsWithIncompleteTokenPrefix(text);
    separatorPending =
      endsWithCompleteToken(text) ||
      endsWithTokenBeforeIncompleteSurrogate(text) ||
      (separatorPending && /[\uD800-\uDBFF]$/u.test(text));
    tildeCarry = text.slice(-2);
    return { text: next, delta: nextDelta };
  };

  return (input) => {
    if (input.delta === null) {
      return projectFull(input.text, null);
    }
    const appended = input.delta;
    if (input.text.length !== inputLength + appended.length) {
      // A prepared snapshot replaced the source instead of extending it.
      return projectFull(input.text, appended);
    }
    if (!active) {
      const windowText = activationTail + appended;
      active = TOKEN_START_RE.test(windowText);
      activationTail = windowText.slice(-1);
      if (!active) {
        inputLength = input.text.length;
        output = input.text;
        return input;
      }
      // The opener can start in retained text, so the canonical transform owns this delta.
      return projectFull(input.text, appended);
    }
    const changesCodeOwnership =
      appended.includes("`") || appended.includes("~~~") || (tildeCarry + appended).includes("~~~");
    if (
      pendingPrefix ||
      separatorPending ||
      TOKEN_START_RE.test(appended) ||
      changesCodeOwnership
    ) {
      return projectFull(input.text, appended);
    }
    inputLength = input.text.length;
    output += appended;
    pendingPrefix = appended.endsWith("<");
    tildeCarry = input.text.slice(-2);
    return { text: output, delta: appended };
  };
}

/** Delivery filter: batch parity through `transform`, bounded work through `create`. */
export const modelSpecialTokensTextFilter: TextFilter = {
  transform: stripModelSpecialTokens,
  create: createModelSpecialTokenProjector,
};
