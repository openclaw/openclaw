import { describe, expect, it } from "vitest";
import { extractTtsDirectiveFacts } from "./directive-facts.js";
import { createTtsDirectiveTextStreamCleaner } from "./directives.js";

describe("extractTtsDirectiveFacts", () => {
  it.each([
    [
      "[[tts:Yes—I understand you clearly now.]]",
      "Yes—I understand you clearly now.",
      "Yes—I understand you clearly now.",
    ],
    ["Go [[tts:hello world]] and return", "Go hello world and return", "hello world"],
    [
      "[[tts:first line\nsecond line]] tail",
      "first line\nsecond line tail",
      "first line\nsecond line",
    ],
    ["Go [[tts:\nhello]] now", "Go hello now", "hello"],
    ["[[tts:text]]", "", undefined],
    ["say hi [[tts:text]] now", "say hi  now", undefined],
  ] as const)(
    "extracts visible speech without exposing reserved markers: %s",
    (input, cleanedText, text) => {
      expect(extractTtsDirectiveFacts(input)).toEqual({
        cleanedText,
        facts: { tagged: true, ...(text === undefined ? {} : { text }) },
      });
    },
  );
});

describe("streaming code escape ownership", () => {
  it.each([
    "Some [[tts:hello there]] note [[tts]]read this[[/tts]] now",
    "Done. [[tts:first line\nsecond line]] more. See [[note",
    "[[tts:text]]Press the ` key.[[/tts:text]] Visible. [[tts:text]]Audio only.[[/tts:text]]",
    "Before \\`literal [[tts:text]]SPEECH_ONLY[[/tts:text]] after",
    "Use \\\\`[[tts:text]]literal[[/tts:text]]` here.",
  ])("matches final parsing at every two-chunk cut: %j", (input) => {
    const expected = extractTtsDirectiveFacts(input).cleanedText;
    for (let cut = 0; cut <= input.length; cut += 1) {
      const cleaner = createTtsDirectiveTextStreamCleaner();
      const streamed = cleaner.push(input.slice(0, cut)) + cleaner.push(input.slice(cut));
      expect(streamed + cleaner.flush(), `cut ${cut}`).toBe(expected);
    }
  });
});
