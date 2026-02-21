import { describe, expect, it } from "vitest";
import { parseGfmTable } from "./table-image.js";

describe("parseGfmTable", () => {
  it("returns null for empty string", () => {
    expect(parseGfmTable("")).toBeNull();
  });

  it("returns null for non-table text", () => {
    expect(parseGfmTable("Hello world\nAnother line")).toBeNull();
  });

  it("returns null when separator row is missing", () => {
    expect(parseGfmTable("| A | B |\n| 1 | 2 |")).toBeNull();
  });

  it("parses a basic two-column table", () => {
    const md = "| Name | Value |\n|------|-------|\n| foo  | bar   |";
    const result = parseGfmTable(md);
    expect(result).not.toBeNull();
    expect(result!.headers).toEqual(["Name", "Value"]);
    expect(result!.rows).toEqual([["foo", "bar"]]);
    expect(result!.aligns).toEqual(["left", "left"]);
  });

  it("detects column alignment", () => {
    const md = "| Left | Center | Right |\n|:-----|:------:|------:|\n| a | b | c |";
    const result = parseGfmTable(md);
    expect(result).not.toBeNull();
    expect(result!.aligns).toEqual(["left", "center", "right"]);
  });

  it("handles multiple rows", () => {
    const md = [
      "| A | B | C |",
      "|---|---|---|",
      "| 1 | 2 | 3 |",
      "| 4 | 5 | 6 |",
      "| 7 | 8 | 9 |",
    ].join("\n");
    const result = parseGfmTable(md);
    expect(result).not.toBeNull();
    expect(result!.rows).toHaveLength(3);
  });

  it("handles leading/trailing pipes", () => {
    const md = "| A | B |\n|---|---|\n| x | y |";
    const result = parseGfmTable(md);
    expect(result).not.toBeNull();
    expect(result!.headers).toEqual(["A", "B"]);
    expect(result!.rows[0]).toEqual(["x", "y"]);
  });

  it("handles empty cells", () => {
    const md = "| A | B |\n|---|---|\n|   |   |";
    const result = parseGfmTable(md);
    expect(result).not.toBeNull();
    expect(result!.rows[0]).toEqual(["", ""]);
  });

  it("strips surrounding whitespace from cells", () => {
    const md = "|  A  |  B  |\n|-----|-----|\n|  x  |  y  |";
    const result = parseGfmTable(md);
    expect(result).not.toBeNull();
    expect(result!.headers).toEqual(["A", "B"]);
    expect(result!.rows[0]).toEqual(["x", "y"]);
  });
});
