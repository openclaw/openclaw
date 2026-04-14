import { describe, expect, it } from "vitest";
import { parseTableSpans } from "./table-spans.js";

function spansOf(text: string, fences: { start: number; end: number }[] = []) {
  return parseTableSpans(text, fences);
}

describe("parseTableSpans", () => {
  describe("first level: complete tables with separator row", () => {
    it("detects a simple markdown table", () => {
      const text = [
        "| Header 1 | Header 2 |",
        "|----------|----------|",
        "| Cell 1   | Cell 2   |",
      ].join("\n");

      const spans = spansOf(text);
      expect(spans).toHaveLength(1);
      expect(spans[0]).toEqual({ start: 0, end: text.length });
    });

    it("detects a table surrounded by text", () => {
      const before = "Some intro text.\n\n";
      const table = ["| A | B |", "|---|---|", "| 1 | 2 |"].join("\n");
      const after = "\n\nAfter table.";
      const text = before + table + after;

      const spans = spansOf(text);
      expect(spans).toHaveLength(1);
      expect(spans[0]?.start).toBe(before.length);
      expect(spans[0]?.end).toBe(before.length + table.length);
    });

    it("detects multiple tables", () => {
      const table1 = ["| A | B |", "|---|---|", "| 1 | 2 |"].join("\n");
      const gap = "\n\nText between.\n\n";
      const table2 = ["| X | Y |", "|---|---|", "| 3 | 4 |"].join("\n");
      const text = table1 + gap + table2;

      const spans = spansOf(text);
      expect(spans).toHaveLength(2);
      expect(spans[0]?.start).toBe(0);
      expect(spans[0]?.end).toBe(table1.length);
      expect(spans[1]?.start).toBe(table1.length + gap.length);
    });

    it("detects table without leading pipe in header", () => {
      const text = ["Header 1 | Header 2", "-------- | --------", "Cell 1   | Cell 2"].join("\n");

      const spans = spansOf(text);
      expect(spans).toHaveLength(1);
    });
  });

  describe("second level: suspected tables without separator row", () => {
    it("detects consecutive pipe-delimited lines starting with |", () => {
      const text = ["| a | b |", "| c | d |"].join("\n");

      const spans = spansOf(text);
      expect(spans).toHaveLength(1);
      expect(spans[0]).toEqual({ start: 0, end: text.length });
    });

    it("ignores a single line with pipes", () => {
      const text = "| a | b |";

      const spans = spansOf(text);
      expect(spans).toHaveLength(0);
    });

    it("ignores shell pipe commands that do not start with |", () => {
      const text = [
        'cat file.txt | grep "error" | sort',
        'ps aux | grep python | awk "{print $2}"',
      ].join("\n");

      const spans = spansOf(text);
      expect(spans).toHaveLength(0);
    });

    it("ignores lines with only one pipe", () => {
      const text = ["| single column", "| another row"].join("\n");

      const spans = spansOf(text);
      expect(spans).toHaveLength(0);
    });

    it("detects partial table at end of buffer during streaming", () => {
      const text = ["| Name | Age |", "| Alice | 30 |"].join("\n");

      const spans = spansOf(text);
      expect(spans).toHaveLength(1);
      expect(spans[0]).toEqual({ start: 0, end: text.length });
    });
  });

  describe("fence span exclusion", () => {
    it("does not detect pipe lines inside code fences", () => {
      const text = ["```", "| a | b |", "|---|---|", "| 1 | 2 |", "```"].join("\n");
      const fenceSpans = [{ start: 0, end: text.length }];

      const spans = spansOf(text, fenceSpans);
      expect(spans).toHaveLength(0);
    });

    it("detects tables outside fences but not inside", () => {
      const table = ["| A | B |", "|---|---|", "| 1 | 2 |"].join("\n");
      const codeBlock = `\n\`\`\`\n| x | y |\n|---|---|\n\`\`\`\n`;
      const text = table + codeBlock;
      const fenceSpans = [{ start: table.length + 1, end: text.length - 1 }];

      const spans = spansOf(text, fenceSpans);
      expect(spans).toHaveLength(1);
      expect(spans[0]?.start).toBe(0);
      expect(spans[0]?.end).toBe(table.length);
    });
  });

  describe("edge cases", () => {
    it("returns empty for plain text without tables", () => {
      const text = "Hello world.\nNo tables here.\nJust plain text.";

      expect(spansOf(text)).toHaveLength(0);
    });

    it("returns empty for empty buffer", () => {
      expect(spansOf("")).toHaveLength(0);
    });

    it("merges overlapping table spans", () => {
      const lines = ["| a | b |", "|---|---|", "| 1 | 2 |", "| 3 | 4 |"];
      const text = lines.join("\n");

      const spans = spansOf(text);
      expect(spans).toHaveLength(1);
    });

    it("handles table at very end without trailing newline", () => {
      const before = "Some text.\n\n";
      const table = "| H1 | H2 |\n|----|----|\n| v1 | v2 |";
      const text = before + table;

      const spans = spansOf(text);
      expect(spans).toHaveLength(1);
      expect(spans[0]?.end).toBe(text.length);
    });

    it("detects tables with alignment colons", () => {
      const text = [
        "| Left | Center | Right |",
        "|:-----|:------:|------:|",
        "| a    | b      | c     |",
      ].join("\n");

      const spans = spansOf(text);
      expect(spans).toHaveLength(1);
      expect(spans[0]).toEqual({ start: 0, end: text.length });
    });

    it("does not merge tables separated by a blank line", () => {
      const table1 = ["| A | B |", "|---|---|", "| 1 | 2 |"].join("\n");
      const gap = "\n\nSome text.\n\n";
      const table2 = ["| X | Y |", "|---|---|", "| 3 | 4 |"].join("\n");
      const text = table1 + gap + table2;

      const spans = spansOf(text);
      expect(spans).toHaveLength(2);
    });

    it("handles rows with differing column counts", () => {
      const text = ["| A | B | C |", "|---|---|---|", "| 1 | 2 |", "| 4 | 5 | 6 | 7 |"].join("\n");

      const spans = spansOf(text);
      expect(spans).toHaveLength(1);
      expect(spans[0]).toEqual({ start: 0, end: text.length });
    });
  });
});
