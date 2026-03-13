import { describe, expect, it } from "vitest";
import { extractFirstTextBlock } from "./chat-message-content.js";

describe("shared/chat-message-content", () => {
  it("extracts the first text block from array content", () => {
    expect(
      extractFirstTextBlock({
        content: [{ text: "hello" }, { text: "world" }],
      }),
    ).toBe("hello");
  });

  it("returns undefined for missing, empty, or non-text content", () => {
    expect(extractFirstTextBlock(null)).toBeUndefined();
    expect(extractFirstTextBlock({ content: [] })).toBeUndefined();
    expect(extractFirstTextBlock({ content: [{ type: "image" }] })).toBeUndefined();
    expect(extractFirstTextBlock({ content: ["hello"] })).toBeUndefined();
  });
});
