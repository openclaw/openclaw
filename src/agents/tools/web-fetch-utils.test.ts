import { describe, expect, it } from "vitest";
import { htmlToMarkdown, truncateText } from "./web-fetch-utils.js";

describe("htmlToMarkdown", () => {
  it("decodes basic HTML entities", () => {
    const result = htmlToMarkdown("<p>&amp; &lt; &gt; &quot; &#39;</p>");
    expect(result.text).toBe("& < > \" '");
  });

  it("decodes numeric HTML entities for ASCII", () => {
    const result = htmlToMarkdown("<p>&#65;&#66;&#67;</p>");
    expect(result.text).toBe("ABC");
  });

  it("decodes hex HTML entities for BMP characters", () => {
    const result = htmlToMarkdown("<p>&#x41;&#x42;&#x43;</p>");
    expect(result.text).toBe("ABC");
  });

  it("decodes hex HTML entities for astral code points (emoji)", () => {
    // &#x1F600; = 😀 (U+1F600, grinning face)
    const result = htmlToMarkdown("<p>&#x1F600;</p>");
    expect(result.text).toBe("😀");
  });

  it("decodes decimal HTML entities for astral code points (emoji)", () => {
    // &#128512; = 😀 (U+1F600)
    const result = htmlToMarkdown("<p>&#128512;</p>");
    expect(result.text).toBe("😀");
  });

  it("handles invalid code points gracefully", () => {
    // Code point beyond Unicode max
    const result = htmlToMarkdown("<p>&#x110000;</p>");
    expect(result.text).toBe("");
  });

  it("extracts title", () => {
    const result = htmlToMarkdown(
      "<html><head><title>Hello</title></head><body>World</body></html>",
    );
    expect(result.title).toBe("Hello");
    expect(result.text).toContain("World");
  });

  it("strips script and style tags", () => {
    const result = htmlToMarkdown(
      "<p>visible</p><script>alert(1)</script><style>.x{}</style><p>also visible</p>",
    );
    expect(result.text).not.toContain("alert");
    expect(result.text).not.toContain(".x{}");
    expect(result.text).toContain("visible");
    expect(result.text).toContain("also visible");
  });
});

describe("truncateText", () => {
  it("returns unchanged text when within limit", () => {
    const result = truncateText("hello", 10);
    expect(result).toEqual({ text: "hello", truncated: false });
  });

  it("truncates text at the limit", () => {
    const result = truncateText("hello world", 5);
    expect(result.text).toBe("hello");
    expect(result.truncated).toBe(true);
  });

  it("does not split a surrogate pair", () => {
    // 😀 is "\uD83D\uDE00" (2 UTF-16 code units)
    const input = "a😀b";
    // input.length === 4: 'a'(1) + surrogate pair(2) + 'b'(1)
    // Cutting at 2 would land between the high and low surrogate
    const result = truncateText(input, 2);
    expect(result.truncated).toBe(true);
    // Should step back to avoid splitting the pair
    expect(result.text).toBe("a");
    expect(result.text.length).toBe(1);
  });

  it("preserves a surrogate pair when limit includes both units", () => {
    const input = "a😀b";
    const result = truncateText(input, 3);
    expect(result.truncated).toBe(true);
    expect(result.text).toBe("a😀");
  });

  it("handles empty string", () => {
    const result = truncateText("", 5);
    expect(result).toEqual({ text: "", truncated: false });
  });

  it("handles zero maxChars", () => {
    const result = truncateText("hello", 0);
    expect(result.text).toBe("");
    expect(result.truncated).toBe(true);
  });
});
