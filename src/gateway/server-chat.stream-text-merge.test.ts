import { describe, expect, it } from "vitest";
import { resolveMergedAssistantText } from "./live-chat-projector.js";

describe("server chat stream text merge", () => {
  it.each([
    {
      name: "repeated digits",
      chunks: ["1", "1", "1"],
      expected: "111",
    },
    {
      name: "repeated CJK punctuation",
      chunks: ["。", "。", "。"],
      expected: "。。。",
    },
    {
      name: "repeated markdown emphasis tokens",
      chunks: ["**", "**"],
      expected: "****",
    },
    {
      name: "repeated markdown table separators",
      chunks: ["|", "|", "|"],
      expected: "|||",
    },
  ])("appends incremental deltas without collapsing $name", ({ chunks, expected }) => {
    const merged = chunks.reduce(
      (previousText, nextDelta) =>
        resolveMergedAssistantText({
          previousText,
          nextText: nextDelta,
          nextDelta,
        }),
      "",
    );

    expect(merged).toBe(expected);
  });

  it("keeps cumulative snapshots from duplicating already-buffered text", () => {
    expect(
      resolveMergedAssistantText({
        previousText: "Hello",
        nextText: "Hello world",
        nextDelta: " world",
      }),
    ).toBe("Hello world");
  });

  it("keeps non-prefix incremental segments after tool calls", () => {
    expect(
      resolveMergedAssistantText({
        previousText: "Before tool call",
        nextText: "After tool call",
        nextDelta: "\nAfter tool call",
      }),
    ).toBe("Before tool call\nAfter tool call");
  });
});
