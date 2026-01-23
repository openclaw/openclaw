import { describe, expect, it } from "vitest";
import { markdownToIR } from "./ir.js";

describe("markdownToIR tableMode bullets", () => {
  it("converts simple table to bullets", () => {
    const md = `
| Name | Value |
|------|-------|
| A    | 1     |
| B    | 2     |
`.trim();

    const ir = markdownToIR(md, { tableMode: "bullets" });
    
    // Should contain bullet points with header:value format
    expect(ir.text).toContain("• Value: 1");
    expect(ir.text).toContain("• Value: 2");
    // Should use first column as labels
    expect(ir.text).toContain("A");
    expect(ir.text).toContain("B");
  });

  it("handles table with multiple columns", () => {
    const md = `
| Feature | SQLite | Postgres |
|---------|--------|----------|
| Speed   | Fast   | Medium   |
| Scale   | Small  | Large    |
`.trim();

    const ir = markdownToIR(md, { tableMode: "bullets" });
    
    // First column becomes row label
    expect(ir.text).toContain("Speed");
    expect(ir.text).toContain("Scale");
    // Other columns become bullet points
    expect(ir.text).toContain("• SQLite: Fast");
    expect(ir.text).toContain("• Postgres: Medium");
    expect(ir.text).toContain("• SQLite: Small");
    expect(ir.text).toContain("• Postgres: Large");
  });

  it("preserves flat mode as default", () => {
    const md = `
| A | B |
|---|---|
| 1 | 2 |
`.trim();

    const ir = markdownToIR(md); // default is flat
    
    // Flat mode uses tabs
    expect(ir.text).toContain("A");
    expect(ir.text).toContain("B");
    expect(ir.text).toContain("1");
    expect(ir.text).toContain("2");
    // Should not have bullet formatting
    expect(ir.text).not.toContain("•");
  });

  it("handles empty cells gracefully", () => {
    const md = `
| Name | Value |
|------|-------|
| A    |       |
| B    | 2     |
`.trim();

    const ir = markdownToIR(md, { tableMode: "bullets" });
    
    // Should handle empty cell without crashing
    expect(ir.text).toContain("B");
    expect(ir.text).toContain("• Value: 2");
  });

  it("bolds row labels in bullets mode", () => {
    const md = `
| Name | Value |
|------|-------|
| Row1 | Data1 |
`.trim();

    const ir = markdownToIR(md, { tableMode: "bullets" });
    
    // Should have bold style for row label
    const hasRowLabelBold = ir.styles.some(
      (s) => s.style === "bold" && ir.text.slice(s.start, s.end) === "Row1"
    );
    expect(hasRowLabelBold).toBe(true);
  });
});
