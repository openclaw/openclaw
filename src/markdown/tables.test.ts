import { describe, expect, it } from "vitest";
import { parseFenceSpans } from "./fences.js";
import {
  convertMarkdownTables,
  isSafeTableBreak,
  parseTableSpans,
} from "./tables.js";

describe("convertMarkdownTables", () => {
  it("falls back to code rendering for block mode", () => {
    const rendered = convertMarkdownTables(
      "| A | B |\n|---|---|\n| 1 | 2 |",
      "block",
    );

    expect(rendered).toContain("```");
    expect(rendered).toContain("| A | B |");
    expect(rendered).toContain("| 1 | 2 |");
  });
});

describe("parseTableSpans", () => {
  it("detects a simple table", () => {
    const text = "| A | B |\n| --- | --- |\n| 1 | 2 |";
    const spans = parseTableSpans(text);
    expect(spans).toHaveLength(1);
    expect(spans[0].start).toBe(0);
    expect(spans[0].end).toBe(text.length);
  });

  it("returns empty when no separator row", () => {
    const text = "| A | B |\n| 1 | 2 |";
    const spans = parseTableSpans(text);
    expect(spans).toHaveLength(0);
  });

  it("does not treat thematic break as table separator", () => {
    // `---` alone is a thematic break (horizontal rule), not a table separator.
    // Even when preceded by a line containing `|`, it should not form a table.
    const text = "some | text\n---\nmore text";
    const spans = parseTableSpans(text);
    expect(spans).toHaveLength(0);
  });

  it("detects multiple tables", () => {
    const text = [
      "| A | B |",
      "| --- | --- |",
      "| 1 | 2 |",
      "",
      "Some text",
      "",
      "| X | Y |",
      "| --- | --- |",
      "| 3 | 4 |",
    ].join("\n");
    const spans = parseTableSpans(text);
    expect(spans).toHaveLength(2);
    expect(text.slice(spans[0].start, spans[0].end)).toContain("| 1 | 2 |");
    expect(text.slice(spans[1].start, spans[1].end)).toContain("| 3 | 4 |");
  });

  it("ignores tables inside code fences", () => {
    const text = ["```", "| A | B |", "| --- | --- |", "| 1 | 2 |", "```"].join(
      "\n",
    );
    const fenceSpans = parseFenceSpans(text);
    const spans = parseTableSpans(text, fenceSpans);
    expect(spans).toHaveLength(0);
  });

  it("detects table with alignment markers in separator", () => {
    const text = "| Left | Center | Right |\n|:---|:---:|---:|\n| a | b | c |";
    const spans = parseTableSpans(text);
    expect(spans).toHaveLength(1);
  });

  it("includes all contiguous data rows", () => {
    const text = [
      "| H1 | H2 |",
      "| --- | --- |",
      "| r1 | r1 |",
      "| r2 | r2 |",
      "| r3 | r3 |",
    ].join("\n");
    const spans = parseTableSpans(text);
    expect(spans).toHaveLength(1);
    expect(text.slice(spans[0].start, spans[0].end)).toContain("| r3 | r3 |");
  });
});

describe("isSafeTableBreak", () => {
  it("returns true outside table spans", () => {
    const spans = [{ start: 10, end: 50 }];
    expect(isSafeTableBreak(spans, 5)).toBe(true);
    expect(isSafeTableBreak(spans, 55)).toBe(true);
  });

  it("returns false inside a table span", () => {
    const spans = [{ start: 10, end: 50 }];
    expect(isSafeTableBreak(spans, 25)).toBe(false);
  });

  it("returns true at span boundaries", () => {
    const spans = [{ start: 10, end: 50 }];
    expect(isSafeTableBreak(spans, 10)).toBe(true);
    expect(isSafeTableBreak(spans, 50)).toBe(true);
  });

  it("returns true with empty spans", () => {
    expect(isSafeTableBreak([], 10)).toBe(true);
  });
});
