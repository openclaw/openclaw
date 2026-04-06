/**
 * Strip model control tokens leaked into assistant text output.
 *
 * Models like GLM-5 and DeepSeek sometimes emit internal delimiter tokens
 * (e.g. `<|assistant|>`, `<|tool_call_result_begin|>`, `<｜begin▁of▁sentence｜>`)
 * in their responses. These use the universal `<|...|>` convention (ASCII or
 * full-width pipe variants) and should never reach end users.
 *
 * Matches inside fenced code blocks or inline code spans are preserved so
 * that documentation / examples that reference these tokens are not corrupted.
 *
 * This is a provider bug — no upstream fix tracked yet.
 * Remove this function when upstream providers stop leaking tokens.
 * @see https://github.com/openclaw/openclaw/issues/40020
 */
import { findCodeRegions, isInsideCode } from "./code-regions.js";

// Match both ASCII pipe <|...|> and full-width pipe <｜...｜> (U+FF5C) variants.
const MODEL_SPECIAL_TOKEN_RE = /<[|｜][^|｜]*[|｜]>/g;

function overlapsCodeRegion(
  start: number,
  end: number,
  codeRegions: { start: number; end: number }[],
): boolean {
  return codeRegions.some((region) => start < region.end && end > region.start);
}

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
  return text.replace(MODEL_SPECIAL_TOKEN_RE, (match, offset) => {
    const start = offset;
    const end = start + match.length;
    return isInsideCode(start, codeRegions) || overlapsCodeRegion(start, end, codeRegions)
      ? match
      : " ";
  });
}
