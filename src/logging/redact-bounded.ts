// Bounded regex replacement prevents large support/log strings from monopolizing the event loop.
const REDACT_REGEX_CHUNK_THRESHOLD = 32_768;
const REDACT_REGEX_CHUNK_SIZE = 16_384;

/** Applies a regex replacement in chunks once input crosses the redaction size threshold. */
export function replacePatternBounded(
  text: string,
  pattern: RegExp,
  replacer: Parameters<string["replace"]>[1],
): string {
  if (text.length <= REDACT_REGEX_CHUNK_THRESHOLD) {
    return text.replace(pattern, replacer);
  }

  let output: string | undefined;
  // Preserve every chunk-local replacement; only defer assembling unchanged output.
  // Chunking may miss matches spanning chunk boundaries; use only for token-like redaction patterns.
  for (let index = 0; index < text.length; index += REDACT_REGEX_CHUNK_SIZE) {
    const chunk = text.slice(index, index + REDACT_REGEX_CHUNK_SIZE);
    const replaced = chunk.replace(pattern, replacer);
    if (output !== undefined) {
      output += replaced;
    } else if (replaced !== chunk) {
      output = text.slice(0, index) + replaced;
    }
  }
  return output ?? text;
}
