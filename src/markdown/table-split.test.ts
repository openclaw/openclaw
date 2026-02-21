import { describe, expect, it } from "vitest";
import { splitMarkdownTables } from "./table-split.js";

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

  it("handles multiple tables with sequential indices", () => {
    const md = [
      "First",
      "",
      "| A | B |",
      "|---|---|",
      "| 1 | 2 |",
      "",
      "Middle",
      "",
      "| X | Y |",
      "|---|---|",
      "| 3 | 4 |",
      "",
      "End",
    ].join("\n");

    const result = splitMarkdownTables(md);
    const tables = result.filter((s) => s.kind === "table");
    expect(tables).toHaveLength(2);
    expect(tables[0]).toHaveProperty("index", 0);
    expect(tables[1]).toHaveProperty("index", 1);
  });

  it("does not split tables inside fenced code blocks", () => {
    const md = "```\n| A | B |\n|---|---|\n| 1 | 2 |\n```";
    const result = splitMarkdownTables(md);
    expect(result).toHaveLength(1);
    expect(result[0]).toHaveProperty("kind", "text");
  });

  it("detects pipeless GFM tables (no leading/trailing pipes)", () => {
    const md = "Intro\n\nA | B\n---|---\n1 | 2\n\nDone";
    const result = splitMarkdownTables(md);
    expect(result.filter((s) => s.kind === "table")).toHaveLength(1);
  });
});
