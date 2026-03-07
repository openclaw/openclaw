/**
 * Detects and truncates repetitive LLM output in streaming text.
 * When the same phrase is repeated many times (e.g. after subagent timeout
 * recovery), we keep a single copy and drop the rest to avoid spam and loops.
 */

export type StreamRepetitionResult = {
  /** Text with repeated suffix removed (at most one copy of the phrase kept). */
  text: string;
  /** True if repetition was detected and text was truncated. */
  detected: boolean;
};

const MIN_PHRASE_LEN = 15;
const MAX_PHRASE_LEN = 500;
/** Minimum number of identical repetitions at the end to consider it a loop. */
const MIN_REPETITIONS = 3;

/**
 * If the end of `text` is the same phrase repeated at least MIN_REPETITIONS times,
 * returns text truncated so only one copy of that phrase remains at the end.
 * Otherwise returns the original text.
 */
export function truncateStreamRepetition(text: string): StreamRepetitionResult {
  if (typeof text !== "string" || text.length < MIN_PHRASE_LEN * MIN_REPETITIONS) {
    return { text, detected: false };
  }

  const maxLen = Math.min(MAX_PHRASE_LEN, Math.floor(text.length / MIN_REPETITIONS));

  for (let phraseLen = MIN_PHRASE_LEN; phraseLen <= maxLen; phraseLen += 1) {
    const phrase = text.slice(-phraseLen);
    let count = 0;
    for (let i = 0; i < text.length; i += phraseLen) {
      const start = text.length - (i + phraseLen);
      if (start < 0) {
        break;
      }
      if (text.slice(start, start + phraseLen) !== phrase) {
        break;
      }
      count += 1;
    }
    if (count >= MIN_REPETITIONS) {
      const keepLen = text.length - (count - 1) * phraseLen;
      return {
        text: text.slice(0, keepLen),
        detected: true,
      };
    }
  }

  return { text, detected: false };
}
