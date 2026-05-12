import { describe, expect, it } from "vitest";
import { convertMarkdownTables } from "./tables.js";

describe("convertMarkdownTables", () => {
  it("falls back to code rendering for block mode", () => {
    const rendered = convertMarkdownTables("| A | B |\n|---|---|\n| 1 | 2 |", "block");

    expect(rendered).toContain("```");
    expect(rendered).toContain("| A | B |");
    expect(rendered).toContain("| 1 | 2 |");
  });
});
