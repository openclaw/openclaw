import { describe, it, expect } from "vitest";
import { formatToolOutputForSidebar, getTruncatedPreview } from "./tool-helpers.ts";

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

    it("wraps plain text output in a text code block", () => {
      const input = "This is plain text output";
      const result = formatToolOutputForSidebar(input);

      expect(result).toBe(`\`\`\`text
This is plain text output
\`\`\``);
    });

    it("formats unified diffs as diff code blocks", () => {
      const input = `--- a/file.txt
+++ b/file.txt
@@
-old
+new`;
      const result = formatToolOutputForSidebar(input);
      expect(result.startsWith("```diff\n")).toBe(true);
      expect(result).toContain("-old");
      expect(result).toContain("+new");
    });

    it("wraps invalid JSON starting with { in a text code block", () => {
      const input = "{not valid json";
      const result = formatToolOutputForSidebar(input);

      expect(result).toBe(`\`\`\`text
{not valid json
\`\`\``);
    });

    it("wraps invalid JSON starting with [ in a text code block", () => {
      const input = "[not valid json";
      const result = formatToolOutputForSidebar(input);

      expect(result).toBe(`\`\`\`text
[not valid json
\`\`\``);
    });

    it("trims whitespace before detecting JSON", () => {
      const input = '   {"trimmed": true}   ';
      const result = formatToolOutputForSidebar(input);

      expect(result).toContain("```json");
      expect(result).toContain('"trimmed"');
    });

    it("strips ANSI sequences", () => {
      const input = "\u001b[31mRED\u001b[0m";
      const result = formatToolOutputForSidebar(input);
      expect(result).toBe(`\`\`\`text
RED
\`\`\``);
    });

    it("strips orphaned SGR fragments when ESC is missing", () => {
      const input = "[1m[46m RUN [49m[22m hello [0m";
      const result = formatToolOutputForSidebar(input);
      expect(result).toBe(`\`\`\`text
 RUN  hello 
\`\`\``);
    });

    it("handles empty string", () => {
      const result = formatToolOutputForSidebar("");
      expect(result).toBe("");
    });

    it("handles whitespace-only string", () => {
      const result = formatToolOutputForSidebar("   ");
      expect(result).toBe("   ");
    });

    it("does not let markdown eat glob patterns", () => {
      const input = "include: src/**/*.test.ts";
      const result = formatToolOutputForSidebar(input);
      expect(result).toContain("src/**/*.test.ts");
      expect(result.startsWith("```text\n")).toBe(true);
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

    it("normalizes CRLF and strips ANSI", () => {
      const input = "A\r\n\u001b[32mB\u001b[0m";
      const result = getTruncatedPreview(input);
      expect(result).toBe("A\nB");
    });
  });
});
