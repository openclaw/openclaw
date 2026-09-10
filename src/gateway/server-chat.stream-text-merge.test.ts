/**
 * Tests chat stream text merging before gateway events reach clients.
 */
import { describe, expect, it } from "vitest";
import { mergeAssistantText, type AssistantTextSnapshot } from "./agent-event-assistant-text.js";
import { capLiveAssistantText } from "./live-chat-projector.js";

const LIVE_CHAT_BUFFER_CHARS = 500_000;

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
    const merged = chunks.reduce<AssistantTextSnapshot>(
      (previous, delta) => mergeAssistantText(previous, { text: delta, delta }, "live"),
      { text: "" },
    );

    expect(merged.text).toBe(expected);
  });

  it.each([
    {
      name: "growing cumulative snapshots",
      previous: "Hello",
      input: { text: "Hello world", delta: " world" },
      live: "Hello world",
      appendOnly: "Hello world",
    },
    {
      name: "incremental segments after tool calls",
      previous: "Before tool call",
      input: { text: "After tool call", delta: "\nAfter tool call" },
      live: "Before tool call\nAfter tool call",
      appendOnly: "Before tool call\nAfter tool call",
    },
    {
      name: "non-prefix snapshots with empty deltas",
      previous: "coordination draft",
      input: { text: "final answer", delta: "" },
      live: "final answer",
      appendOnly: "coordination draft",
    },
    {
      name: "repeated text with an explicit delta",
      previous: "Echo",
      input: { text: "Echo", delta: "Echo" },
      live: "EchoEcho",
      appendOnly: "Echo",
    },
  ])("preserves legacy unkeyed handling of $name", ({ previous, input, live, appendOnly }) => {
    expect(mergeAssistantText({ text: previous }, input, "live").text).toBe(live);
    expect(mergeAssistantText({ text: previous }, input, "append-only").text).toBe(appendOnly);
  });

  it("caps merged live text while preserving the newest assistant output", () => {
    const result = capLiveAssistantText(
      mergeAssistantText(
        { text: "a".repeat(LIVE_CHAT_BUFFER_CHARS - 2) },
        { delta: "bbbb" },
        "live",
      ),
    );

    expect(result).toHaveLength(LIVE_CHAT_BUFFER_CHARS);
    expect(result.endsWith("bbbb")).toBe(true);
  });

  it("does not resurrect a discarded scoped prefix after a shorter correction", () => {
    const snapshot = "y".repeat(LIVE_CHAT_BUFFER_CHARS - 6);
    const merged = mergeAssistantText(
      { text: "x🚀keep" },
      { itemId: "answer", text: snapshot, delta: snapshot },
      "live",
    );
    const capped = capLiveAssistantText(merged);
    expect(capped).toBe(`keep\n\n${snapshot}`);
    expect(
      capLiveAssistantText(
        mergeAssistantText(
          { text: capped, scope: merged.scope },
          { itemId: "answer", text: "!", delta: "" },
          "live",
        ),
      ),
    ).toBe("keep\n\n!");
  });

  it.each([
    {
      name: "no trailing newline",
      prefix: "First.",
      next: "Second.",
      expected: "First.\n\nSecond.",
    },
    {
      name: "one trailing newline",
      prefix: "First.\n",
      next: "Second.",
      expected: "First.\n\nSecond.",
    },
    {
      name: "paragraph break already present",
      prefix: "First.\n\n",
      next: "Second.",
      expected: "First.\n\nSecond.",
    },
    {
      name: "leading newlines on the next item",
      prefix: "First.",
      next: "\n\nSecond.",
      expected: "First.\n\nSecond.",
    },
    {
      name: "table as the next item",
      prefix: "Intro line",
      next: "| a | b |\n| - | - |",
      expected: "Intro line\n\n| a | b |\n| - | - |",
    },
    { name: "empty prefix", prefix: "", next: "Second.", expected: "Second." },
    { name: "empty next item", prefix: "First.", next: "", expected: "First." },
  ])(
    "keeps a paragraph boundary between distinct assistant items ($name)",
    ({ prefix, next, expected }) => {
      expect(
        mergeAssistantText(
          { text: prefix },
          { itemId: "next-item", text: next, delta: next },
          "live",
        ).text,
      ).toBe(expected);
    },
  );

  it("owes the paragraph boundary to a new item that starts with a delta, not to its later deltas", () => {
    const first = mergeAssistantText(
      { text: "First." },
      { itemId: "next-item", delta: "Sec" },
      "live",
    );
    expect(first.text).toBe("First.\n\nSec");
    const grown = mergeAssistantText(first, { itemId: "next-item", delta: "ond." }, "live");
    expect(grown.text).toBe("First.\n\nSecond.");
    expect(
      mergeAssistantText(grown, { itemId: "next-item", text: "Second!", delta: "!" }, "live").text,
    ).toBe("First.\n\nSecond!");
  });

  it("does not start the capped tail with the low half of a surrogate pair", () => {
    const safeTail = "y".repeat(LIVE_CHAT_BUFFER_CHARS - 1);
    const result = capLiveAssistantText(
      mergeAssistantText({ text: "" }, { text: `x🚀${safeTail}`, delta: "" }, "live"),
    );

    expect(result).toBe(safeTail);
  });

  it.each([
    { leading: "", itemLength: LIVE_CHAT_BUFFER_CHARS - 1, corrected: "\n!" },
    { leading: "", itemLength: LIVE_CHAT_BUFFER_CHARS, corrected: "!" },
    { leading: "", itemLength: LIVE_CHAT_BUFFER_CHARS + 1, corrected: "!" },
    { leading: "\n", itemLength: LIVE_CHAT_BUFFER_CHARS - 1, corrected: "\n!" },
    { leading: "\n", itemLength: LIVE_CHAT_BUFFER_CHARS, corrected: "!" },
    { leading: "\n\n", itemLength: LIVE_CHAT_BUFFER_CHARS, corrected: "!" },
  ])(
    "retains only the uncapped boundary for leading $leading and length $itemLength",
    ({ leading, itemLength, corrected }) => {
      const merged = mergeAssistantText(
        { text: "First." },
        { itemId: "answer", text: leading + "y".repeat(itemLength - leading.length) },
        "live",
      );
      const capped = capLiveAssistantText(merged);
      expect(capped).toHaveLength(LIVE_CHAT_BUFFER_CHARS);
      const grown = mergeAssistantText(
        { text: capped, scope: merged.scope },
        { itemId: "answer", delta: "?" },
        "live",
      );
      expect(grown.text).toBe(`${capped}?`);
      const replacement = mergeAssistantText(grown, { itemId: "answer", text: "!" }, "live");
      expect(replacement.text).toBe(corrected);
      expect(mergeAssistantText(replacement, { itemId: "answer", delta: "?" }, "live").text).toBe(
        `${corrected}?`,
      );
    },
  );

  it("recalculates padding when a current-item snapshot gains a leading newline", () => {
    const previous = mergeAssistantText(
      { text: "First." },
      { itemId: "answer", text: "\nSecond." },
      "live",
    );
    expect(previous.text).toBe("First.\n\nSecond.");
    const corrected = mergeAssistantText(
      previous,
      { itemId: "answer", text: "\n\nSecond." },
      "live",
    );
    expect(corrected.text).toBe("First.\n\nSecond.");
    expect(mergeAssistantText(corrected, { itemId: "answer", delta: "!" }, "live").text).toBe(
      "First.\n\nSecond.!",
    );
  });
});
