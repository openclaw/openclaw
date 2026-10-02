import { describe, expect, it } from "vitest";
import { mergeAssistantText } from "./agent-event-assistant-text.js";
import { capLiveAssistantText } from "./live-chat-projector.js";

const LIVE_CHAT_BUFFER_CHARS = 500_000;

describe("server chat stream text merge", () => {
  it.each([
    ["coordination draft", "final answer", "", "final answer", "coordination draft"],
    ["Echo", "Echo", "Echo", "EchoEcho", "Echo"],
  ])(
    "preserves legacy unkeyed handling from %j to %j",
    (previous, text, delta, live, appendOnly) => {
      const input = { text, delta };
      expect(mergeAssistantText({ text: previous }, input, "live").text).toBe(live);
      expect(mergeAssistantText({ text: previous }, input, "append-only").text).toBe(appendOnly);
    },
  );

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
    ["First.\n", "Second.", "First.\n\nSecond."],
    ["First.", "", "First."],
  ])(
    "keeps a paragraph boundary between distinct assistant items %j and %j",
    (prefix, next, expected) => {
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
    { itemLength: LIVE_CHAT_BUFFER_CHARS - 1, corrected: "\n!" },
    { itemLength: LIVE_CHAT_BUFFER_CHARS + 1, corrected: "!" },
  ])("retains only the uncapped boundary for length $itemLength", ({ itemLength, corrected }) => {
    const merged = mergeAssistantText(
      { text: "First." },
      { itemId: "answer", text: "y".repeat(itemLength) },
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
  });

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
