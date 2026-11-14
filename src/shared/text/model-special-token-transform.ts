import { findCodeRegions } from "./code-ranges.js";
import type { findCodeOwnership } from "./code-regions.js";
const MODEL_SPECIAL_TOKEN_RE = /<[|｜][^|｜\s]*[|｜]>/g;

/** Blank-line boundary the canonical ownership parser uses to settle reference definitions. */
function findLastBlankLine(text: string): number {
  let lastBlank = -1;
  for (const blank of text.matchAll(/(?:\r\n|\n|\r(?!\n))[ \t]*(?:\r\n|\n|\r(?!\n))/g)) {
    lastBlank = blank.index;
  }
  return lastBlank;
}

export function projectModelSpecialTokens(
  text: string,
  resolveOwnership?: (text: string) => ReturnType<typeof findCodeOwnership>,
): {
  text: string;
  codeOwnershipPending: boolean;
  hasRetainedInlineCode: boolean;
} {
  if (!text) {
    return { text, codeOwnershipPending: false, hasRetainedInlineCode: false };
  }
  MODEL_SPECIAL_TOKEN_RE.lastIndex = 0;
  if (!MODEL_SPECIAL_TOKEN_RE.test(text)) {
    return { text, codeOwnershipPending: false, hasRetainedInlineCode: false };
  }
  MODEL_SPECIAL_TOKEN_RE.lastIndex = 0;

  const ownership = /[`~\t]| {4}/u.test(text) ? resolveOwnership?.(text) : undefined;
  const codeRegions = ownership?.regions ?? findCodeRegions(text);
  // Inline code can become a link destination, image label, or table cell on append.
  // Unsettled definitions can also restore code in earlier image references.
  const lastBlank = ownership?.definitions.length ? findLastBlankLine(text) : -1;
  let codeOwnershipPending =
    ownership?.definitions.some((definition) => definition.end > lastBlank) ?? false;
  const retainStart = ownership?.retainStart ?? text.length;
  const hasLabelCandidate = ownership?.textSpans.some(
    ([start, end]) =>
      end > retainStart && text.slice(Math.max(start, retainStart), end).includes("["),
  );
  const hasLineBreak = /[\r\n]/.test(text.slice(retainStart));
  let hasRetainedInlineCode = false;
  let out = "";
  let cursor = 0;
  for (const match of text.matchAll(MODEL_SPECIAL_TOKEN_RE)) {
    const matched = match[0];
    const start = match.index ?? 0;
    const end = start + matched.length;
    out += text.slice(cursor, start);
    const code = codeRegions.find((region) => start < region.end && end > region.start);
    if (code) {
      out += matched;
      if (!code.block && code.end > retainStart) {
        hasRetainedInlineCode = true;
        // Parser-owned bracket text can still consume code as link/image/reference syntax.
        // Otherwise, a plain code-bearing line can only become a table at a line boundary.
        codeOwnershipPending ||= hasLabelCandidate || hasLineBreak;
      }
    } else {
      // A token body can itself contain backticks; any code overlap preserves the token.
      codeOwnershipPending ||=
        text.lastIndexOf("`", end - 1) >= retainStart && text.includes("`", start);
      if (
        // Retained text handles adjacent tokens; two code units preserve astral letters.
        // Keep alternation: Node 26.5's V8 misses astral letters in `$`-anchored `u` classes.
        // A following combining mark stays attached, and punctuation needs no separator.
        /(?:\p{L}|\p{M}|\p{N})$/u.test(out.slice(-2)) &&
        /^[\p{L}\p{N}]/u.test(text.slice(end, end + 2))
      ) {
        out += " ";
      }
    }
    cursor = end;
  }
  out += text.slice(cursor);
  return { text: out, codeOwnershipPending, hasRetainedInlineCode };
}

/**
 * Strips leaked model control tokens like `<|assistant|>` or full-width pipe variants.
 * Code examples are preserved; remove this when providers stop emitting these tokens.
 *
 * @see https://github.com/openclaw/openclaw/issues/40020
 */
export function stripModelSpecialTokens(text: string): string {
  return projectModelSpecialTokens(text).text;
}
