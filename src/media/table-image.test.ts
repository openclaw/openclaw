import { describe, expect, it } from "vitest";
import { parseGfmTable } from "./table-image.js";

describe("parseGfmTable", () => {
  it("returns null for non-table text", () => {
    expect(parseGfmTable("")).toBeNull();
    expect(parseGfmTable("Hello world\nAnother line")).toBeNull();
    expect(parseGfmTable("| A | B |\n| 1 | 2 |")).toBeNull(); // missing separator
  });

  it("parses a table with alignment and multiple rows", () => {
    const md = "| Left | Center | Right |\n|:-----|:------:|------:|\n| a | b | c |\n| d | e | f |";
    const result = parseGfmTable(md);
    expect(result).not.toBeNull();
    expect(result!.headers).toEqual(["Left", "Center", "Right"]);
    expect(result!.aligns).toEqual(["left", "center", "right"]);
    expect(result!.rows).toHaveLength(2);
  });

  it("handles escaped pipes in cells", () => {
    const md = "| A | B |\n|---|---|\n| foo\\|bar | baz |";
    const result = parseGfmTable(md);
    expect(result).not.toBeNull();
    expect(result!.rows[0]).toEqual(["foo|bar", "baz"]);
  });

  it("handles double-backslash before pipe as literal backslash + delimiter", () => {
    // \\| = literal backslash + pipe delimiter (even number of backslashes)
    const md = "| A | B |\n|---|---|\n| foo\\\\| baz |";
    const result = parseGfmTable(md);
    expect(result).not.toBeNull();
    expect(result!.rows[0]).toEqual(["foo\\", "baz"]);
  });

  it("pads short rows to header width", () => {
    const md = "| A | B | C |\n|---|---|---|\n| 1 |";
    const result = parseGfmTable(md);
    expect(result).not.toBeNull();
    expect(result!.rows[0]).toEqual(["1", "", ""]);
  });

  it("returns null when table exceeds size limits", () => {
    const cols = Array.from({ length: 25 }, (_, i) => `C${i}`);
    const seps = cols.map(() => "---");
    const md = `| ${cols.join(" | ")} |\n| ${seps.join(" | ")} |\n| ${cols.join(" | ")} |`;
    expect(parseGfmTable(md)).toBeNull(); // >20 cols

    const header = "| A | B |\n|---|---|";
    const rows = Array.from({ length: 65 }, (_, i) => `| ${i} | v |`);
    expect(parseGfmTable(`${header}\n${rows.join("\n")}`)).toBeNull(); // >60 rows
  });

  it("truncates cells exceeding max length", () => {
    const longText = "x".repeat(600);
    const md = `| A |\n|---|\n| ${longText} |`;
    const result = parseGfmTable(md);
    expect(result).not.toBeNull();
    expect(result!.rows[0][0].length).toBeLessThanOrEqual(501);
    expect(result!.rows[0][0].endsWith("…")).toBe(true);
  });
});
