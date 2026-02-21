import { describe, expect, it } from "vitest";
import { hasMarkdownTable, splitMarkdownTables } from "./table-split.js";

describe("hasMarkdownTable", () => {
  it("returns false for empty string", () => {
    expect(hasMarkdownTable("")).toBe(false);
  });

  it("returns false for plain text", () => {
    expect(hasMarkdownTable("Hello world\nThis is some text.")).toBe(false);
  });

  it("returns true for a simple GFM table", () => {
    const md = `| A | B |\n|---|---|\n| 1 | 2 |`;
    expect(hasMarkdownTable(md)).toBe(true);
  });

  it("returns false for a table inside a fenced code block", () => {
    const md = "```\n| A | B |\n|---|---|\n| 1 | 2 |\n```";
    expect(hasMarkdownTable(md)).toBe(false);
  });

  it("returns true when table is mixed with other content", () => {
    const md = "Some text\n\n| X | Y |\n|---|---|\n| a | b |\n\nMore text";
    expect(hasMarkdownTable(md)).toBe(true);
  });

  it("returns false for pipe characters that are not tables", () => {
    expect(hasMarkdownTable("a | b | c")).toBe(false);
  });
});

describe("splitMarkdownTables", () => {
  it("returns empty array for empty string", () => {
    expect(splitMarkdownTables("")).toEqual([]);
  });

  it("returns single text segment when no tables", () => {
    const md = "Hello world\nParagraph two";
    const result = splitMarkdownTables(md);
    expect(result).toEqual([{ kind: "text", markdown: md }]);
  });

  it("splits a single table with surrounding text", () => {
    const md = [
      "Intro paragraph",
      "",
      "| Col A | Col B |",
      "|-------|-------|",
      "| val1  | val2  |",
      "",
      "Closing paragraph",
    ].join("\n");

    const result = splitMarkdownTables(md);
    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({ kind: "text", markdown: expect.stringContaining("Intro") });
    expect(result[1]).toEqual({
      kind: "table",
      markdown: expect.stringContaining("Col A"),
      index: 0,
    });
    expect(result[2]).toEqual({ kind: "text", markdown: expect.stringContaining("Closing") });
  });

  it("handles multiple tables interleaved with text", () => {
    const md = [
      "First text",
      "",
      "| A | B |",
      "|---|---|",
      "| 1 | 2 |",
      "",
      "Middle text",
      "",
      "| X | Y |",
      "|---|---|",
      "| 3 | 4 |",
      "",
      "End text",
    ].join("\n");

    const result = splitMarkdownTables(md);
    expect(result.filter((s) => s.kind === "table")).toHaveLength(2);
    expect(result.filter((s) => s.kind === "text")).toHaveLength(3);

    // Table indices should be sequential
    const tables = result.filter((s) => s.kind === "table");
    expect(tables[0]).toHaveProperty("index", 0);
    expect(tables[1]).toHaveProperty("index", 1);
  });

  it("handles a table at the very start of the markdown", () => {
    const md = "| A | B |\n|---|---|\n| 1 | 2 |\n\nAfter the table";
    const result = splitMarkdownTables(md);
    expect(result[0]).toHaveProperty("kind", "table");
  });

  it("handles a table at the very end of the markdown", () => {
    const md = "Before the table\n\n| A | B |\n|---|---|\n| 1 | 2 |";
    const result = splitMarkdownTables(md);
    const last = result.at(-1);
    expect(last).toHaveProperty("kind", "table");
  });

  it("does not split tables inside fenced code blocks", () => {
    const md = "```\n| A | B |\n|---|---|\n| 1 | 2 |\n```";
    const result = splitMarkdownTables(md);
    expect(result).toHaveLength(1);
    expect(result[0]).toHaveProperty("kind", "text");
  });

  it("handles table-only content (no surrounding text)", () => {
    const md = "| A | B |\n|---|---|\n| 1 | 2 |";
    const result = splitMarkdownTables(md);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ kind: "table", markdown: md, index: 0 });
  });
});
