import { describe, expect, it } from "vitest";
import { extractTextFromChatContent } from "./chat-content.js";

describe("extractTextFromChatContent", () => {
  it("normalizes string content", () => {
    expect(extractTextFromChatContent("  hello\nworld  ")).toBe("hello world");
  });

  it("extracts text blocks from array content", () => {
    expect(
      extractTextFromChatContent([
        { type: "text", text: " hello " },
        { type: "image_url", image_url: "https://example.com" },
        { type: "text", text: "world" },
      ]),
    ).toBe("hello world");
  });

  it("applies sanitizer when provided", () => {
    expect(
      extractTextFromChatContent("Here [Tool Call: foo (ID: 1)] ok", {
        sanitizeText: (text) => text.replace(/\[Tool Call:[^\]]+\]\s*/g, ""),
      }),
    ).toBe("Here ok");
  });
});
