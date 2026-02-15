import { describe, it, expect } from "vitest";
import { formatToolOutputForSidebar, getTruncatedPreview, linkifyUrls } from "./tool-helpers.ts";

describe("tool-helpers", () => {
  describe("formatToolOutputForSidebar", () => {
    it("formats valid JSON object as code block", () => {
      const input = '{"name":"test","value":123}';
      const result = formatToolOutputForSidebar(input);

      expect(result).toBe(`\`\`\`json
{
  "name": "test",
  "value": 123
}
\`\`\``);
    });

    it("formats valid JSON array as code block", () => {
      const input = "[1, 2, 3]";
      const result = formatToolOutputForSidebar(input);

      expect(result).toBe(`\`\`\`json
[
  1,
  2,
  3
]
\`\`\``);
    });

    it("handles nested JSON objects", () => {
      const input = '{"outer":{"inner":"value"}}';
      const result = formatToolOutputForSidebar(input);

      expect(result).toContain("```json");
      expect(result).toContain('"outer"');
      expect(result).toContain('"inner"');
    });

    it("returns plain text for non-JSON content", () => {
      const input = "This is plain text output";
      const result = formatToolOutputForSidebar(input);

      expect(result).toBe("This is plain text output");
    });

    it("returns as-is for invalid JSON starting with {", () => {
      const input = "{not valid json";
      const result = formatToolOutputForSidebar(input);

      expect(result).toBe("{not valid json");
    });

    it("returns as-is for invalid JSON starting with [", () => {
      const input = "[not valid json";
      const result = formatToolOutputForSidebar(input);

      expect(result).toBe("[not valid json");
    });

    it("trims whitespace before detecting JSON", () => {
      const input = '   {"trimmed": true}   ';
      const result = formatToolOutputForSidebar(input);

      expect(result).toContain("```json");
      expect(result).toContain('"trimmed"');
    });

    it("handles empty string", () => {
      const result = formatToolOutputForSidebar("");
      expect(result).toBe("");
    });

    it("handles whitespace-only string", () => {
      const result = formatToolOutputForSidebar("   ");
      expect(result).toBe("   ");
    });
  });

  describe("getTruncatedPreview", () => {
    it("returns short text unchanged", () => {
      const input = "Short text";
      const result = getTruncatedPreview(input);

      expect(result).toBe("Short text");
    });

    it("truncates text longer than max chars", () => {
      const input = "a".repeat(150);
      const result = getTruncatedPreview(input);

      expect(result.length).toBe(101); // 100 chars + ellipsis
      expect(result.endsWith("…")).toBe(true);
    });

    it("truncates to max lines", () => {
      const input = "Line 1\nLine 2\nLine 3\nLine 4\nLine 5";
      const result = getTruncatedPreview(input);

      // Should only show first 2 lines (PREVIEW_MAX_LINES = 2)
      expect(result).toBe("Line 1\nLine 2…");
    });

    it("adds ellipsis when lines are truncated", () => {
      const input = "Line 1\nLine 2\nLine 3";
      const result = getTruncatedPreview(input);

      expect(result.endsWith("…")).toBe(true);
    });

    it("does not add ellipsis when all lines fit", () => {
      const input = "Line 1\nLine 2";
      const result = getTruncatedPreview(input);

      expect(result).toBe("Line 1\nLine 2");
      expect(result.endsWith("…")).toBe(false);
    });

    it("handles single line within limits", () => {
      const input = "Single line";
      const result = getTruncatedPreview(input);

      expect(result).toBe("Single line");
    });

    it("handles empty string", () => {
      const result = getTruncatedPreview("");
      expect(result).toBe("");
    });

    it("truncates by chars even within line limit", () => {
      // Two lines but very long content
      const longLine = "x".repeat(80);
      const input = `${longLine}\n${longLine}`;
      const result = getTruncatedPreview(input);

      expect(result.length).toBe(101); // 100 + ellipsis
      expect(result.endsWith("…")).toBe(true);
    });
  });

  describe("linkifyUrls", () => {
    it("escapes html characters", () => {
      const input = "<div>&\"'</div>";
      const result = linkifyUrls(input);
      expect(result).toBe("&lt;div&gt;&amp;&quot;&#039;&lt;/div&gt;");
    });

    it("converts simple url to link", () => {
      const input = "Check https://example.com";
      const result = linkifyUrls(input);
      expect(result).toBe(
        'Check <a href="https://example.com" target="_blank" rel="noopener noreferrer" class="chat-link">https://example.com</a>',
      );
    });

    it("converts url with path and query", () => {
      const input = "http://test.com/path?q=1";
      const result = linkifyUrls(input);
      expect(result).toBe(
        '<a href="http://test.com/path?q=1" target="_blank" rel="noopener noreferrer" class="chat-link">http://test.com/path?q=1</a>',
      );
    });

    it("handles text with html and url", () => {
      const input = "<b>Link:</b> https://example.com";
      const result = linkifyUrls(input);
      expect(result).toBe(
        '&lt;b&gt;Link:&lt;/b&gt; <a href="https://example.com" target="_blank" rel="noopener noreferrer" class="chat-link">https://example.com</a>',
      );
    });

    it("handles multiple urls", () => {
      const input = "https://a.com and https://b.com";
      const result = linkifyUrls(input);
      expect(result).toBe(
        '<a href="https://a.com" target="_blank" rel="noopener noreferrer" class="chat-link">https://a.com</a> and <a href="https://b.com" target="_blank" rel="noopener noreferrer" class="chat-link">https://b.com</a>',
      );
    });

    it("does not match non-http urls", () => {
      const input = "file:///tmp/test";
      const result = linkifyUrls(input);
      expect(result).toBe("file:///tmp/test");
    });

    it("excludes trailing punctuation from url", () => {
      const cases = [
        [
          "(https://example.com)",
          '(<a href="https://example.com" target="_blank" rel="noopener noreferrer" class="chat-link">https://example.com</a>)',
        ],
        [
          "https://example.com.",
          '<a href="https://example.com" target="_blank" rel="noopener noreferrer" class="chat-link">https://example.com</a>.',
        ],
        [
          "https://example.com,",
          '<a href="https://example.com" target="_blank" rel="noopener noreferrer" class="chat-link">https://example.com</a>,',
        ],
        [
          "https://example.com!",
          '<a href="https://example.com" target="_blank" rel="noopener noreferrer" class="chat-link">https://example.com</a>!',
        ],
        [
          "End with https://example.com?",
          'End with <a href="https://example.com" target="_blank" rel="noopener noreferrer" class="chat-link">https://example.com</a>?',
        ],
        [
          "[Link](https://example.com)",
          '[Link](<a href="https://example.com" target="_blank" rel="noopener noreferrer" class="chat-link">https://example.com</a>)',
        ],
      ];

      cases.forEach(([input, expected]) => {
        expect(linkifyUrls(input)).toBe(expected);
      });
    });

    it("preserves newlines", () => {
      const input = "Line 1\nhttps://example.com\nLine 3";
      const result = linkifyUrls(input);
      expect(result).toBe(
        'Line 1\n<a href="https://example.com" target="_blank" rel="noopener noreferrer" class="chat-link">https://example.com</a>\nLine 3',
      );
    });
  });
});
