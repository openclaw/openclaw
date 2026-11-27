import { sanitizeTerminalText } from "../../packages/terminal-core/src/safe-text.js";
import { isTranscriptArtifactText } from "../media-understanding/transcription-text.js";
import { createTranscriptSpeechOrder } from "../shared/transcript-speech-order.js";

/** Assign readable names in recording order. Keep account IDs local to this transcript. */
export function createTranscriptSpeakerLabels(onAlias?: () => void) {
  const labels = new Map<string, string>();
  const suffixes = new Map<string, number>();

  return (id: string | null | undefined, rawLabel: string | null | undefined): string => {
    const label = sanitizeTerminalText(rawLabel ?? "").trim();
    // A label-only importer cannot attest that its "Sam" is an identified account.
    const key = id ? `id:${id}` : `label:${label}`;
    let display = labels.get(key);
    if (!label) {
      return display ?? "";
    }
    if (display === undefined) {
      display = label;
      let suffix = suffixes.get(label) ?? 1;
      // A literal display name such as "Sam (2)" can already own a numbered name.
      while (suffixes.has(display)) {
        suffix += 1;
        display = `${label} (${suffix})`;
      }
      suffixes.set(label, suffix);
      suffixes.set(display, 1);
      labels.set(key, display);
    }
    if (display !== label) {
      onAlias?.();
    }
    return display;
  };
}

export type TranscriptDisplayTurn = { text: string; speakerLabel: string };

/** Callers resolve names before filtering so skipped speech cannot change a later attribution. */
export function presentTranscriptTurn(
  text: string,
  speakerLabel: string,
): TranscriptDisplayTurn | undefined {
  if (isTranscriptArtifactText(text)) {
    return undefined;
  }
  const speech = sanitizeTerminalText(text).trim();
  return speech !== text && isTranscriptArtifactText(speech)
    ? undefined
    : { text: speech, speakerLabel };
}

export function formatTranscriptTurn(turn: TranscriptDisplayTurn): string {
  return turn.speakerLabel ? `${turn.speakerLabel}: ${turn.text}` : turn.text;
}

/** Names are already resolved in append order, even when an earlier speaker finishes later. */
export function presentTranscriptTurns(
  rows: (TranscriptDisplayTurn & { startedAt?: string | null })[],
): TranscriptDisplayTurn[] {
  const speech = createTranscriptSpeechOrder<TranscriptDisplayTurn>();
  for (const { text, speakerLabel, startedAt } of rows) {
    const turn = presentTranscriptTurn(text, speakerLabel);
    if (turn) {
      speech.add(turn, startedAt);
    }
  }
  return speech.finish();
}
