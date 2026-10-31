import { describe, expect, it, vi } from "vitest";
import {
  createTtsDirectiveTextStreamCleaner,
  extractTtsDirectiveFacts,
} from "./directive-facts.js";

it("loads and cleans streamed text without provider discovery", async () => {
  vi.resetModules();
  try {
    // mock-isolation: Streamed directive text must not load provider discovery, even transitively.
    vi.doMock("./provider-registry.js", () => {
      throw new Error("streamed directive text loaded provider discovery");
    });
    const { createTtsDirectiveTextStreamCleaner: createCleaner } =
      await import("./directive-facts.js");
    const cleaner = createCleaner();
    expect(
      cleaner.push("Visible [[tts:provider=missing voice=example]]text") + cleaner.flush(),
    ).toBe("Visible text");
  } finally {
    vi.doUnmock("./provider-registry.js");
    vi.resetModules();
  }
});

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

describe("createTtsDirectiveTextStreamCleaner", () => {
  const hidden = "[[tts:text]]Press the ` key.[[/tts:text]]";
  it.each([
    [
      ["Hello [[tts:voice=al", "loy]]world[[/tt", "s]]"],
      ["Hello ", "world", ""],
    ],
    [
      ["Shown [[tts:text]]hid", "den[[/tts:text]] visible"],
      ["Shown ", " visible"],
    ],
  ] as const)("cleans every incremental chunk: %j", (chunks, expected) => {
    const cleaner = createTtsDirectiveTextStreamCleaner();
    expect(chunks.map((chunk) => cleaner.push(chunk))).toEqual(expected);
    expect(cleaner.flush()).toBe("");
  });

  it.each([
    [["Some [[tts:hello there]] note"], "Some hello there note"],
    [["Go [[tts:", "answered aloud]] back"], "Go answered aloud back"],
    [["Done. [[tts:first line\nsecond line]] more"], "Done. first line\nsecond line more"],
    [["Go [[tts:\nhello]] now"], "Go hello now"],
    [["[[tts]]read", " this[[/tts]] now"], "read this now"],
    [["See [[note"], "See [[note"],
    [[`${hidden} Visible. [[tts:text]]Audio only.[[/tts:text]]`], " Visible. "],
    [[hidden, " Visible. [[tts:text]]Audio only.[[/tts:text]]"], " Visible. "],
  ] as const)("preserves visible reply text across chunks: %j", (chunks, expected) => {
    const cleaner = createTtsDirectiveTextStreamCleaner();
    expect(chunks.map((chunk) => cleaner.push(chunk)).join("") + cleaner.flush()).toBe(expected);
  });

  it.each([
    ["```\n", "[[tts:literal", " speech]]\n", "```\n"],
    ["Use `", "[[tts:literal", " speech]]", "` here."],
    ["~~~\n~~~ [[note]]\n[[tts:Literal speech]]\n~~~"],
    ["~~~\n~~~ [[tts:voice=alloy]]\n[[tts:Literal speech]]\n~~~"],
  ])("preserves code literals across chunks: %j", (...chunks) => {
    const cleaner = createTtsDirectiveTextStreamCleaner();
    expect(chunks.map((chunk) => cleaner.push(chunk)).join("")).toBe(chunks.join(""));
    expect(cleaner.push("\n[[tts:Visible speech]]")).toBe("\nVisible speech");
    expect(cleaner.flush()).toBe("");
  });
});
