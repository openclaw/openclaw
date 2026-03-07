import { describe, expect, it } from "vitest";
import { createEchoTracker } from "./echo.js";

describe("createEchoTracker", () => {
  it("remembers and matches plain text", () => {
    const tracker = createEchoTracker({});
    tracker.rememberText("hello world", {});
    expect(tracker.has("hello world")).toBe(true);
    expect(tracker.has("other text")).toBe(false);
  });

  it("forgets text after explicit forget()", () => {
    const tracker = createEchoTracker({});
    tracker.rememberText("hello", {});
    expect(tracker.has("hello")).toBe(true);
    tracker.forget("hello");
    expect(tracker.has("hello")).toBe(false);
  });

  it("evicts oldest entries when exceeding maxItems", () => {
    const tracker = createEchoTracker({ maxItems: 3 });
    tracker.rememberText("a", {});
    tracker.rememberText("b", {});
    tracker.rememberText("c", {});
    tracker.rememberText("d", {});
    // "a" should be evicted
    expect(tracker.has("a")).toBe(false);
    expect(tracker.has("b")).toBe(true);
    expect(tracker.has("d")).toBe(true);
  });

  it("ignores undefined/empty text", () => {
    const tracker = createEchoTracker({});
    tracker.rememberText(undefined, {});
    tracker.rememberText("", {});
    expect(tracker.has("")).toBe(false);
    expect(tracker.has("undefined")).toBe(false);
  });

  it("stores combined body key when provided", () => {
    const tracker = createEchoTracker({});
    tracker.rememberText("chunk 1", {
      combinedBody: "chunk 1\nchunk 2",
      combinedBodySessionKey: "session:abc",
    });
    const key = tracker.buildCombinedKey({
      sessionKey: "session:abc",
      combinedBody: "chunk 1\nchunk 2",
    });
    expect(tracker.has(key)).toBe(true);
  });
});

describe("echo tracker: self-chat echo loop prevention", () => {
  it("matches WhatsApp-converted chunks, not just raw markdown", () => {
    // Simulates the fix: each converted chunk is stored individually.
    // When WhatsApp echoes back the converted text, it matches.
    const tracker = createEchoTracker({});

    // Raw markdown (what used to be stored):
    const rawMarkdown = "**Important**: Check the _docs_ for details.";
    // WhatsApp-converted (what actually gets echoed back):
    const whatsappFormatted = "*Important*: Check the _docs_ for details.";

    // Store the converted text (post-fix behavior)
    tracker.rememberText(whatsappFormatted, {});

    // Echo arrives as WhatsApp-formatted text
    expect(tracker.has(whatsappFormatted)).toBe(true);
    // Raw markdown would NOT match if only it was stored
    expect(tracker.has(rawMarkdown)).toBe(false);
  });

  it("matches individual chunks when text is split", () => {
    const tracker = createEchoTracker({});

    // Long text gets chunked before sending
    const chunk1 = "First part of the response that was sent.";
    const chunk2 = "Second part of the response that was sent.";
    const fullText = `${chunk1}\n${chunk2}`;

    // Each chunk is stored individually (post-fix behavior)
    tracker.rememberText(chunk1, {});
    tracker.rememberText(chunk2, {});

    // WhatsApp echoes back each chunk as a separate message
    expect(tracker.has(chunk1)).toBe(true);
    expect(tracker.has(chunk2)).toBe(true);
    // Full text is NOT stored (so no false match on combined echo)
    expect(tracker.has(fullText)).toBe(false);
  });
});
