import { describe, expect, it } from "vitest";
import { convertMarkdownTables } from "./tables.js";

describe("convertMarkdownTables", () => {
  it("renders tables as code blocks in code mode", () => {
    const md = "| A | B |\n|---|---|\n| 1 | 2 |";
    const result = convertMarkdownTables(md, "code");
    expect(result).toContain("```");
    expect(result).toContain("A");
    expect(result).toContain("2");
  });

  it("falls back to code mode for block mode (text-only converter)", () => {
    const md = "before\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\nafter";
    const result = convertMarkdownTables(md, "block");
    // Should NOT silently drop table content
    expect(result).toContain("A");
    expect(result).toContain("2");
    expect(result).toContain("before");
    expect(result).toContain("after");
    // Should render as code block (the fallback)
    expect(result).toContain("```");
  });

  it("returns input unchanged for off mode", () => {
    const md = "| A |\n|---|\n| 1 |";
    expect(convertMarkdownTables(md, "off")).toBe(md);
  });

  it("returns input unchanged when no tables present", () => {
    const md = "Just some text.";
    expect(convertMarkdownTables(md, "code")).toBe(md);
  });
});
