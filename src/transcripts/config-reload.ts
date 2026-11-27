import { isDeepStrictEqual } from "node:util";
import type { TranscriptsConfig } from "./config.js";

function withoutTitles(config: TranscriptsConfig | undefined) {
  return (
    config && {
      ...config,
      ...(config.autoStart && {
        autoStart: config.autoStart.map(({ title: _title, ...source }) => source),
      }),
    }
  );
}

/** Compare full source intent before reading titles, without borrowing new routing authority. */
export function hasSameTranscriptCaptureIntent(
  previous: TranscriptsConfig | undefined,
  candidate: TranscriptsConfig | undefined,
): boolean {
  return isDeepStrictEqual(withoutTitles(previous), withoutTitles(candidate));
}
