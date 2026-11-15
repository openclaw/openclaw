import { describe, expect, it } from "vitest";
import {
  CODE_HEAVY_SPOKEN_FALLBACK,
  isCodeHeavySpeechText,
  normalizeSpeechText,
} from "./speech-text.js";

describe("speech text normalization", () => {
  it("falls back when fenced code is at least half of the reply", () => {
    const input = `Brief note.

\`\`\`ts
export function renderAnswer() {
  return "most of this reply is code";
}
\`\`\``;

    expect(isCodeHeavySpeechText(input)).toBe(true);
    expect(normalizeSpeechText(input)).not.toBe(CODE_HEAVY_SPOKEN_FALLBACK);
  });
});
