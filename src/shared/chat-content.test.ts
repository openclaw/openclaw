import { describe, expect, it } from "vitest";
import { extractTextFromChatContent } from "./chat-content.js";

describe("extractTextFromChatContent", () => {
  it("returns text from a plain string", () => {
    expect(extractTextFromChatContent("hello world")).toBe("hello world");
  });

  it("returns null for empty string", () => {
    expect(extractTextFromChatContent("")).toBeNull();
  });

  it("returns null for non-string non-array", () => {
    expect(extractTextFromChatContent(42)).toBeNull();
    expect(extractTextFromChatContent(null)).toBeNull();
    expect(extractTextFromChatContent(undefined)).toBeNull();
  });

  it("extracts text from an array of content blocks", () => {
    const content = [
      { type: "text", text: "hello" },
      { type: "text", text: "world" },
    ];
    expect(extractTextFromChatContent(content)).toBe("hello world");
  });

  it("skips non-text blocks", () => {
    const content = [
      { type: "image", url: "http://example.com/img.png" },
      { type: "text", text: "hello" },
    ];
    expect(extractTextFromChatContent(content)).toBe("hello");
  });

  it("extracts text from a JSON-stringified array of content blocks", () => {
    const blocks = [
      { type: "text", text: "hello" },
      { type: "text", text: "world" },
    ];
    const content = JSON.stringify(blocks);
    expect(extractTextFromChatContent(content)).toBe("hello world");
  });

  it("returns plain text for a string that starts with [ but is not valid JSON", () => {
    expect(extractTextFromChatContent("[not valid json")).toBe("[not valid json");
  });

  it("returns plain text for a JSON array that does not contain content blocks", () => {
    const content = JSON.stringify([1, 2, 3]);
    expect(extractTextFromChatContent(content)).toBe("[1,2,3]");
  });

  it("returns plain text for a JSON array of objects without type/text", () => {
    const content = JSON.stringify([{ foo: "bar" }]);
    expect(extractTextFromChatContent(content)).toBe('[{"foo":"bar"}]');
  });

  it("extracts text from a JSON-stringified mixed-content array (text + image blocks)", () => {
    const blocks = [
      { type: "image_url", image_url: { url: "https://example.com/img.png" } },
      { type: "text", text: "hello" },
    ];
    const content = JSON.stringify(blocks);
    expect(extractTextFromChatContent(content)).toBe("hello");
  });

  it("applies sanitizeText to JSON-stringified content blocks", () => {
    const blocks = [{ type: "text", text: "hello <b>world</b>" }];
    const content = JSON.stringify(blocks);
    const result = extractTextFromChatContent(content, {
      sanitizeText: (t) => t.replace(/<[^>]+>/g, ""),
    });
    expect(result).toBe("hello world");
  });

  it("applies joinWith to JSON-stringified content blocks", () => {
    const blocks = [
      { type: "text", text: "hello" },
      { type: "text", text: "world" },
    ];
    const content = JSON.stringify(blocks);
    // Default normalizeText collapses whitespace; use identity to preserve the join separator.
    expect(extractTextFromChatContent(content, { joinWith: "\n", normalizeText: (t) => t })).toBe(
      "hello\nworld",
    );
  });
});
