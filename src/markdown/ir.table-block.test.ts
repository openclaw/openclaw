import { describe, expect, it } from "vitest";
import { markdownToIRWithMeta } from "./ir.js";

describe("markdownToIRWithMeta tableMode block", () => {
  it("extracts table data into ir.tables", () => {
    const md = "| Name | Age |\n|------|-----|\n| Alice | 30 |";
    const { ir, hasTables } = markdownToIRWithMeta(md, { tableMode: "block" });

    expect(hasTables).toBe(true);
    expect(ir.tables).toBeDefined();
    expect(ir.tables).toHaveLength(1);
    expect(ir.tables![0].headers).toEqual(["Name", "Age"]);
    expect(ir.tables![0].rows).toEqual([["Alice", "30"]]);
  });

  it("does not inline table text in the IR", () => {
    const md = "before\n\n| A |\n|---|\n| 1 |\n\nafter";
    const { ir } = markdownToIRWithMeta(md, { tableMode: "block" });

    // Table content should not appear in the text stream
    expect(ir.text).not.toContain("| A |");
    expect(ir.text).not.toContain("| 1 |");
    // Surrounding text should be present
    expect(ir.text).toContain("before");
    expect(ir.text).toContain("after");
  });

  it("records placeholderOffset for each table", () => {
    const md = "intro\n\n| X |\n|---|\n| 1 |";
    const { ir } = markdownToIRWithMeta(md, { tableMode: "block" });

    expect(ir.tables).toHaveLength(1);
    expect(typeof ir.tables![0].placeholderOffset).toBe("number");
    expect(ir.tables![0].placeholderOffset).toBeGreaterThanOrEqual(0);
  });

  it("handles multiple tables", () => {
    const md = "| A |\n|---|\n| 1 |\n\nmiddle\n\n| B |\n|---|\n| 2 |";
    const { ir } = markdownToIRWithMeta(md, { tableMode: "block" });

    expect(ir.tables).toHaveLength(2);
    expect(ir.tables![0].headers).toEqual(["A"]);
    expect(ir.tables![1].headers).toEqual(["B"]);
  });

  it("does not populate tables in non-block modes", () => {
    const md = "| A |\n|---|\n| 1 |";
    const { ir } = markdownToIRWithMeta(md, { tableMode: "code" });
    expect(ir.tables).toBeUndefined();
  });

  it("handles table-only content (no surrounding text)", () => {
    const md = "| Col |\n|-----|\n| Val |";
    const { ir } = markdownToIRWithMeta(md, { tableMode: "block" });

    expect(ir.tables).toHaveLength(1);
    expect(ir.tables![0].headers).toEqual(["Col"]);
    // Text should be empty or whitespace-only
    expect(ir.text.trim()).toBe("");
  });
});
