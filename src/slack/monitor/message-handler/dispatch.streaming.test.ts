import { describe, expect, it } from "vitest";
import {
  filterReasoningFromPartial,
  isSlackStreamingEnabled,
  resolveSlackStreamingThreadHint,
} from "./dispatch.js";

describe("slack native streaming defaults", () => {
  it("is enabled for partial mode when native streaming is on", () => {
    expect(isSlackStreamingEnabled({ mode: "partial", nativeStreaming: true })).toBe(true);
  });

  it("is disabled outside partial mode or when native streaming is off", () => {
    expect(isSlackStreamingEnabled({ mode: "partial", nativeStreaming: false })).toBe(false);
    expect(isSlackStreamingEnabled({ mode: "block", nativeStreaming: true })).toBe(false);
    expect(isSlackStreamingEnabled({ mode: "progress", nativeStreaming: true })).toBe(false);
    expect(isSlackStreamingEnabled({ mode: "off", nativeStreaming: true })).toBe(false);
  });
});

describe("slack native streaming thread hint", () => {
  it("stays off-thread when replyToMode=off and message is not in a thread", () => {
    expect(
      resolveSlackStreamingThreadHint({
        replyToMode: "off",
        incomingThreadTs: undefined,
        messageTs: "1000.1",
      }),
    ).toBeUndefined();
  });

  it("uses first-reply thread when replyToMode=first", () => {
    expect(
      resolveSlackStreamingThreadHint({
        replyToMode: "first",
        incomingThreadTs: undefined,
        messageTs: "1000.2",
      }),
    ).toBe("1000.2");
  });

  it("uses the existing incoming thread regardless of replyToMode", () => {
    expect(
      resolveSlackStreamingThreadHint({
        replyToMode: "off",
        incomingThreadTs: "2000.1",
        messageTs: "1000.3",
      }),
    ).toBe("2000.1");
  });
});

describe("filterReasoningFromPartial", () => {
  it("returns undefined for empty/undefined input", () => {
    expect(filterReasoningFromPartial(undefined)).toBeUndefined();
    expect(filterReasoningFromPartial("")).toBeUndefined();
    expect(filterReasoningFromPartial("   ")).toBeUndefined();
  });

  it("passes through normal text unchanged", () => {
    expect(filterReasoningFromPartial("Hello, world!")).toBe("Hello, world!");
  });

  it("strips thinking tags and returns answer text", () => {
    expect(filterReasoningFromPartial("<think>reasoning here</think>answer")).toBe("answer");
  });

  it("returns undefined for text that is only thinking content", () => {
    expect(filterReasoningFromPartial("<think>only reasoning</think>")).toBeUndefined();
  });

  it('returns undefined for "Reasoning:\\n" prefixed messages', () => {
    expect(filterReasoningFromPartial("Reasoning:\nsome thought process")).toBeUndefined();
  });

  it("handles trailing whitespace gracefully", () => {
    expect(filterReasoningFromPartial("answer text   ")).toBe("answer text");
  });
});
