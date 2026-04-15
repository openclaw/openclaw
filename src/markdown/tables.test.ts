import { describe, expect, it } from "vitest";
import { convertMarkdownTables } from "./tables.js";
import { isSafeTableBreak, parseTableSpans } from "./table-spans.js";

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
  it("detects a simple markdown table", () => {
    const md = "| A | B |\n|---|---|\n| 1 | 2 |";
    const spans = parseTableSpans(md, []);
    expect(spans).toHaveLength(1);
    expect(spans[0].start).toBe(0);
    expect(spans[0].end).toBe(md.length);
  });

  it("does not treat thematic breaks as table separators", () => {
    const md = "Some heading\n---\nBody text";
    const spans = parseTableSpans(md, []);
    expect(spans).toHaveLength(0);
  });

  it("skips tables inside fenced code blocks", () => {
    const md = "```\n| A | B |\n|---|---|\n| 1 | 2 |\n```";
    const fenceSpans = [
      { start: 0, end: md.length, openLine: "```", marker: "```", indent: "" },
    ];
    const spans = parseTableSpans(md, fenceSpans);
    expect(spans).toHaveLength(0);
  });

  it("detects multiple tables", () => {
    const md = "| A |\n|---|\n| 1 |\n\nText\n\n| B |\n|---|\n| 2 |";
    const spans = parseTableSpans(md, []);
    expect(spans).toHaveLength(2);
  });

  it("extends span to buffer end when table is at the trailing edge (streaming)", () => {
    const md = "| A | B |\n|---|---|\n";
    const spans = parseTableSpans(md, []);
    expect(spans).toHaveLength(1);
    // Span must cover the trailing newline so the chunker cannot split there.
    expect(spans[0].end).toBe(md.length);
  });

  it("does not extend span when content follows the table", () => {
    const md = "| A |\n|---|\n| 1 |\n\nAfter";
    const spans = parseTableSpans(md, []);
    expect(spans).toHaveLength(1);
    // Span ends at the last data row, not at text.length.
    expect(spans[0].end).toBeLessThan(md.length);
  });
});

describe("isSafeTableBreak", () => {
  it("returns false for an index inside a table span", () => {
    const spans = [{ start: 0, end: 30 }];
    expect(isSafeTableBreak(spans, 15)).toBe(false);
  });

  it("returns true for an index outside any table span", () => {
    const spans = [{ start: 0, end: 10 }];
    expect(isSafeTableBreak(spans, 20)).toBe(true);
  });

  it("returns true at exact boundary (end is exclusive)", () => {
    const spans = [{ start: 0, end: 10 }];
    expect(isSafeTableBreak(spans, 10)).toBe(true);
  });
});
