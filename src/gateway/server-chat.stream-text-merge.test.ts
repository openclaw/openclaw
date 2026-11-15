import { expect, it } from "vitest";
import {
  createAssistantTextStream,
  mergeAssistantText,
  type AssistantTextSnapshot,
} from "./agent-event-assistant-text.js";
import { capLiveAssistantText } from "./live-chat-projector.js";

const LIVE_CHAT_BUFFER_CHARS = 500_000;

const merge = (
  previous: string | AssistantTextSnapshot,
  input: Parameters<typeof mergeAssistantText>[1],
) =>
  mergeAssistantText(typeof previous === "string" ? { text: previous } : previous, input, "live");

it("keeps certified raw appends independent of display text and reconciles final corrections", () => {
  const stream = createAssistantTextStream(false);
  expect([
    stream.update({ itemId: "answer", text: "provisional display" }, "Raw"),
    stream.update({ itemId: "answer", text: "different display" }, " bytes"),
    stream.streamedText,
    stream.update({ itemId: "answer", text: "Raw bytes!", replace: true }),
    stream.update({ itemId: "answer", text: "Correction", replace: true }),
  ]).toEqual([
    { delta: "Raw" },
    { delta: " bytes" },
    "Raw bytes",
    { delta: "!", replacement: "representable" },
    { replacement: "unrepresentable" },
  ]);
});

it.each([
  ["coordination draft", "final answer", "", "final answer", "coordination draft"],
  ["Echo", "Echo", "Echo", "EchoEcho", "Echo"],
])("preserves legacy unkeyed handling from %j to %j", (previous, text, delta, live, appendOnly) => {
  const input = { text, delta };
  expect(mergeAssistantText({ text: previous }, input, "live").text).toBe(live);
  expect(mergeAssistantText({ text: previous }, input, "append-only").text).toBe(appendOnly);
});

it("does not resurrect a discarded scoped prefix after a shorter correction", () => {
  const snapshot = "y".repeat(LIVE_CHAT_BUFFER_CHARS - 6);
  const merged = merge("x🚀keep", { itemId: "answer", text: snapshot, delta: snapshot });
  const capped = capLiveAssistantText(merged);
  expect(capped).toBe(`keep\n\n${snapshot}`);
  expect(
    capLiveAssistantText(
      merge({ text: capped, scope: merged.scope }, { itemId: "answer", text: "!", delta: "" }),
    ),
  ).toBe("keep\n\n!");
});

it("owes the paragraph boundary to a new item that starts with a delta, not to its later deltas", () => {
  const first = merge("First.", { itemId: "next-item", delta: "Sec" });
  expect(first.text).toBe("First.\n\nSec");
  const grown = merge(first, { itemId: "next-item", delta: "ond." });
  expect(grown.text).toBe("First.\n\nSecond.");
  expect(merge(grown, { itemId: "next-item", text: "Second!", delta: "!" }).text).toBe(
    "First.\n\nSecond!",
  );
});

it("does not start the capped tail with the low half of a surrogate pair", () => {
  const safeTail = "y".repeat(LIVE_CHAT_BUFFER_CHARS - 1);
  const result = capLiveAssistantText(merge("", { text: `x🚀${safeTail}`, delta: "" }));
  expect(result).toBe(safeTail);
});

it.each([
  { itemLength: LIVE_CHAT_BUFFER_CHARS - 1, corrected: "\n!" },
  { itemLength: LIVE_CHAT_BUFFER_CHARS + 1, corrected: "!" },
])("retains only the uncapped boundary for length $itemLength", ({ itemLength, corrected }) => {
  const merged = merge("First.", { itemId: "answer", text: "y".repeat(itemLength) });
  const capped = capLiveAssistantText(merged);
  expect(capped).toHaveLength(LIVE_CHAT_BUFFER_CHARS);
  const grown = merge({ text: capped, scope: merged.scope }, { itemId: "answer", delta: "?" });
  expect(grown.text).toBe(`${capped}?`);
  const replacement = merge(grown, { itemId: "answer", text: "!" });
  expect(replacement.text).toBe(corrected);
  expect(merge(replacement, { itemId: "answer", delta: "?" }).text).toBe(`${corrected}?`);
});

it("recalculates padding when a current-item snapshot gains a leading newline", () => {
  const previous = merge("First.", { itemId: "answer", text: "\nSecond." });
  expect(previous.text).toBe("First.\n\nSecond.");
  const corrected = merge(previous, { itemId: "answer", text: "\n\nSecond." });
  expect(corrected.text).toBe("First.\n\nSecond.");
  expect(merge(corrected, { itemId: "answer", delta: "!" }).text).toBe("First.\n\nSecond.!");
});
