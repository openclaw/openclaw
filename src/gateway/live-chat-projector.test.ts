import { describe, expect, it } from "vitest";
import { hasLiveAssistantContent, resolveMergedAssistantText } from "./live-chat-projector.js";

describe("hasLiveAssistantContent", () => {
  it("returns true for text-only events", () => {
    expect(hasLiveAssistantContent({ text: "hi" })).toBe(true);
  });

  it("returns true for delta-only events", () => {
    expect(hasLiveAssistantContent({ delta: "hi" })).toBe(true);
  });

  it("returns true when both text and delta are present", () => {
    expect(hasLiveAssistantContent({ text: "hi", delta: "lo" })).toBe(true);
  });

  it("returns false when neither text nor delta are strings", () => {
    expect(hasLiveAssistantContent({})).toBe(false);
    expect(hasLiveAssistantContent({ text: 1, delta: 2 })).toBe(false);
    expect(hasLiveAssistantContent({ text: null, delta: undefined })).toBe(false);
  });

  it("returns false for null, undefined, or non-object data", () => {
    expect(hasLiveAssistantContent(null)).toBe(false);
    expect(hasLiveAssistantContent(undefined)).toBe(false);
    expect(hasLiveAssistantContent("hello")).toBe(false);
    expect(hasLiveAssistantContent(42)).toBe(false);
  });

  it("accepts an empty string as valid live content", () => {
    expect(hasLiveAssistantContent({ text: "" })).toBe(true);
    expect(hasLiveAssistantContent({ delta: "" })).toBe(true);
  });
});

describe("resolveMergedAssistantText delta-only inputs", () => {
  it("treats delta as the first chunk when previous buffer is empty", () => {
    const result = resolveMergedAssistantText({
      previousText: "",
      nextText: "",
      nextDelta: "hello",
    });
    expect(result).toBe("hello");
  });

  it("appends delta to the previous buffer when text is absent", () => {
    const result = resolveMergedAssistantText({
      previousText: "hello ",
      nextText: "",
      nextDelta: "world",
    });
    expect(result).toBe("hello world");
  });

  it("returns the previous buffer when both text and delta are empty", () => {
    const result = resolveMergedAssistantText({
      previousText: "buffered",
      nextText: "",
      nextDelta: "",
    });
    expect(result).toBe("buffered");
  });
});
