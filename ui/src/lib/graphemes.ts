// The supported browser floor includes Segmenter; don't split emoji into code points.
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function takeGraphemes(input: string, limit: number): string {
  // A grapheme needs at least one UTF-16 code unit, so these strings cannot truncate.
  if (input.length <= limit) {
    return input;
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
