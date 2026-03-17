import { describe, expect, it } from "vitest";
import {
  hasReplyChannelData,
  hasReplyContent,
  normalizeInteractiveReply,
  resolveInteractiveTextFallback,
} from "./payload.js";

describe("hasReplyChannelData", () => {
  it("accepts non-empty objects only", () => {
    expect(hasReplyChannelData(undefined)).toBe(false);
    expect(hasReplyChannelData({})).toBe(false);
    expect(hasReplyChannelData([])).toBe(false);
    expect(hasReplyChannelData({ slack: { blocks: [] } })).toBe(true);
  });
});

describe("hasReplyContent", () => {
  it("treats whitespace-only text and empty structured payloads as empty", () => {
    expect(
      hasReplyContent({
        text: "   ",
        mediaUrls: ["", "   "],
        interactive: { blocks: [] },
        hasChannelData: false,
      }),
    ).toBe(false);
  });

  it("accepts shared interactive blocks and explicit extra content", () => {
    expect(
      hasReplyContent({
        interactive: {
          blocks: [{ type: "buttons", buttons: [{ label: "Retry", value: "retry" }] }],
        },
      }),
    ).toBe(true);
    expect(
      hasReplyContent({
        text: "   ",
        extraContent: true,
      }),
    ).toBe(true);
  });
});

describe("interactive payload helpers", () => {
  it("normalizes interactive replies and resolves text fallbacks", () => {
    const interactive = normalizeInteractiveReply({
      blocks: [
        { type: "text", text: "First" },
        { type: "buttons", buttons: [{ label: "Retry", value: "retry" }] },
        { type: "text", text: "Second" },
      ],
    });

    expect(interactive).toEqual({
      blocks: [
        { type: "text", text: "First" },
        { type: "buttons", buttons: [{ label: "Retry", value: "retry" }] },
        { type: "text", text: "Second" },
      ],
    });
    expect(resolveInteractiveTextFallback({ interactive })).toBe("First\n\nSecond");
  });
});
