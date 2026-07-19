// Shared grapheme-cluster slicing for Control UI text fallbacks (plugin
// monograms, agent avatar initials). Single owner so emoji/composed characters
// cannot drift between surfaces or split UTF-16 surrogate pairs.
const graphemeSegmenter =
  typeof Intl.Segmenter === "function"
    ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
    : null;

/** Returns the first `limit` grapheme clusters of `input`, Unicode-safe. */
export function takeGraphemes(input: string, limit: number): string {
  if (!graphemeSegmenter) {
    return Array.from(input).slice(0, limit).join("");
  }
  let result = "";
  let count = 0;
  for (const { segment } of graphemeSegmenter.segment(input)) {
    result += segment;
    count += 1;
    if (count >= limit) {
      break;
    }
  }
  return result;
}
