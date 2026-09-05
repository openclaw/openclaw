// Bounded regex replacement prevents large support/log strings from monopolizing the event loop.
export const REDACT_REGEX_CHUNK_THRESHOLD = 32_768;
const REDACT_REGEX_CHUNK_SIZE = 16_384;

type BoundedRedactOptions = {
  chunkThreshold?: number;
  chunkSize?: number;
};

/** Applies a regex replacement in chunks once input crosses the redaction size threshold. */
export function replacePatternBounded(
  text: string,
  pattern: RegExp,
  replacer: Parameters<string["replace"]>[1],
  options?: BoundedRedactOptions,
): string {
  const chunkThreshold = options?.chunkThreshold ?? REDACT_REGEX_CHUNK_THRESHOLD;
  const chunkSize = options?.chunkSize ?? REDACT_REGEX_CHUNK_SIZE;
  if (chunkThreshold <= 0 || chunkSize <= 0 || text.length <= chunkThreshold) {
    return text.replace(pattern, replacer);
  }

  const chunks: string[] = [];
  // Chunking may miss matches spanning chunk boundaries; use only for token-like redaction patterns.
  for (let index = 0; index < text.length; index += chunkSize) {
    chunks.push(text.slice(index, index + chunkSize).replace(pattern, replacer));
  }
  return chunks.join("");
}
