import { parseDateStringTimestampMs } from "@openclaw/normalization-core/number-coercion";

/** Collect presented speech across pages or chunks without changing append cursors. */
export function createTranscriptSpeechOrder<T>() {
  const ordered: T[] = [];
  const timed: { start: number; turn: T }[] = [];
  function flushTimed() {
    timed.sort((a, b) => a.start - b.start);
    for (const { turn } of timed) {
      ordered.push(turn);
    }
    timed.length = 0;
  }
  return {
    add(turn: T, startedAt: string | null | undefined) {
      // A local wall time can denote different instants on the Gateway and in a browser.
      const start =
        startedAt && /(?:z|gmt|utc|[+-]\d{2}:?\d{2})$/iu.test(startedAt.trim())
          ? parseDateStringTimestampMs(startedAt.trim())
          : undefined;
      if (start === undefined) {
        // Without a speech time the recorded position is the only ordering evidence.
        flushTimed();
        ordered.push(turn);
      } else {
        timed.push({ start, turn });
      }
    },
    finish() {
      flushTimed();
      return ordered;
    },
  };
}

export function orderTranscriptSpeech<T extends { startedAt?: string | null }>(
  turns: readonly T[],
): T[] {
  const speech = createTranscriptSpeechOrder<T>();
  for (const turn of turns) {
    speech.add(turn, turn.startedAt);
  }
  return speech.finish();
}
