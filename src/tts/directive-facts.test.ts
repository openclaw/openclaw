import { describe, expect, it } from "vitest";
import { extractTtsDirectiveFacts } from "./directive-facts.js";

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
