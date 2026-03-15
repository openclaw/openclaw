/**
 * Chunk text by finding break points within a sliding window.
 *
 * @param text - The text to chunk
 * @param limit - Maximum chunk length
 * @param resolveBreakIndex - Function to find break point within window, receives window text and optional window start position
 * @returns Array of text chunks
 */
export function chunkTextByBreakResolver(
  text: string,
  limit: number,
  resolveBreakIndex: (window: string, windowStart?: number) => number,
): string[] {
  if (!text) {
    return [];
  }
  if (limit <= 0 || text.length <= limit) {
    return [text];
  }
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > limit) {
    const windowStart = text.length - remaining.length;
    const window = remaining.slice(0, limit);
    const candidateBreak = resolveBreakIndex(window, windowStart);
    const breakIdx =
      Number.isFinite(candidateBreak) &&
      candidateBreak > 0 &&
      candidateBreak <= limit
        ? candidateBreak
        : limit;
    const rawChunk = remaining.slice(0, breakIdx);
    const chunk = rawChunk.trimEnd();
    if (chunk.length > 0) {
      chunks.push(chunk);
    }
    const brokeOnSeparator =
      breakIdx < remaining.length && /\s/.test(remaining[breakIdx]);
    const nextStart = Math.min(
      remaining.length,
      breakIdx + (brokeOnSeparator ? 1 : 0),
    );
    remaining = remaining.slice(nextStart).trimStart();
  }
  if (remaining.length) {
    chunks.push(remaining);
  }
  return chunks;
}