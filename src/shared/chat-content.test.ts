import { describe, expect, it } from "vitest";
import { extractTextFromChatContent } from "./chat-content.js";

describe("extractTextFromChatContent", () => {
  it("extracts string content directly", () => {
    expect(extractTextFromChatContent("Hello world")).toBe("Hello world");
  });

  it("returns null for empty string", () => {
    expect(extractTextFromChatContent("")).toBeNull();
    expect(extractTextFromChatContent("   ")).toBeNull();
  });

  it("normalizes whitespace in strings", () => {
    expect(extractTextFromChatContent("Hello  \n\n  world")).toBe("Hello world");
  });

  it("extracts text from content blocks", () => {
    const content = [
      { type: "text", text: "Hello" },
      { type: "text", text: "world" },
    ];
    expect(extractTextFromChatContent(content)).toBe("Hello world");
  });

  it("skips non-text blocks", () => {
    const content = [
      { type: "text", text: "Hello" },
      { type: "image", url: "https://example.com/img.png" },
      { type: "text", text: "world" },
    ];
    expect(extractTextFromChatContent(content)).toBe("Hello world");
  });

  it("skips blocks without text", () => {
    const content = [
      { type: "text", text: "Hello" },
      { type: "text" },
      { type: "text", text: "" },
      { type: "text", text: "world" },
    ];
    expect(extractTextFromChatContent(content)).toBe("Hello world");
  });

  it("returns null for empty content array", () => {
    expect(extractTextFromChatContent([])).toBeNull();
  });

  it("skips null and undefined blocks", () => {
    const content = [
      null,
      { type: "text", text: "Hello" },
      undefined,
    ];
    expect(extractTextFromChatContent(content)).toBe("Hello");
  });

  it("customizes join separator", () => {
    const content = [{ type: "text", text: "a" }, { type: "text", text: "b" }];
    expect(extractTextFromChatContent(content, { joinWith: "\n" })).toBe("a\nb");
  });

  it("applies custom sanitize function", () => {
    const content = "Hello [redacted]";
    expect(
      extractTextFromChatContent(content, { sanitizeText: (t) => t.replace("[redacted]", "") }),
    ).toBe("Hello");
  });

  it("returns null for non-string/non-array content", () => {
    expect(extractTextFromChatContent(123 as any)).toBeNull();
    expect(extractTextFromChatContent({} as any)).toBeNull();
    expect(extractTextFromChatContent(null)).toBeNull();
  });
});
