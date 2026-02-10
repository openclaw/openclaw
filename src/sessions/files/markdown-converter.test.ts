import { describe, it, expect } from "vitest";
import {
  csvToMarkdownTable,
  jsonToMarkdown,
  textToMarkdown,
  pdfToMarkdown,
  convertToMarkdown,
} from "./markdown-converter.js";

describe("csvToMarkdownTable", () => {
  it("converts simple CSV to markdown table", () => {
    const csv = "id,name,price\n1,Product A,100\n2,Product B,200";
    const result = csvToMarkdownTable(csv);
    // Library format includes trailing spaces in cells
    expect(result).toBe(
      "| id | name      | price | \n|----|-----------|-------| \n| 1  | Product A | 100   | \n| 2  | Product B | 200   |",
    );
  });

  it("handles empty cells", () => {
    const csv = "id,name,price\n1,,100\n2,Product B,";
    const result = csvToMarkdownTable(csv);
    // Empty cells should be represented as a space between pipes
    expect(result).toMatch(/\| 1\s+\| \s+\| 100\s+\|/);
    expect(result).toMatch(/\| 2\s+\| Product B \| \s+\|/);
  });

  it("handles special characters in cells", () => {
    const csv = 'id,description\n1,"Product, with comma"\n2,"Product | with pipe"';
    const result = csvToMarkdownTable(csv);
    // Library preserves commas but escapes pipes in markdown
    expect(result).toContain("Product, with comma");
    expect(result).toContain("Product \\| with pipe"); // Pipe is escaped as \|
  });

  it("handles empty CSV", () => {
    const result = csvToMarkdownTable("");
    expect(result).toBe("");
  });

  it("handles CSV with only headers", () => {
    const csv = "id,name,price";
    const result = csvToMarkdownTable(csv);
    // Library format includes trailing spaces
    expect(result).toBe("| id | name | price | \n|----|------|-------|");
  });
});

describe("jsonToMarkdown", () => {
  it("converts JSON object to markdown code block", () => {
    const json = '{"key":"value","number":123}';
    const result = jsonToMarkdown(json);
    expect(result).toContain("```json");
    expect(result).toContain('"key": "value"');
    expect(result).toContain("```");
  });

  it("preserves indentation", () => {
    const json = '{\n  "key": "value"\n}';
    const result = jsonToMarkdown(json);
    expect(result).toContain('  "key"');
  });

  it("handles invalid JSON gracefully", () => {
    const json = "{ invalid json }";
    const result = jsonToMarkdown(json);
    expect(result).toContain("```json");
    expect(result).toContain("{ invalid json }");
  });
});

describe("textToMarkdown", () => {
  it("keeps markdown-compatible text as-is", () => {
    const text = "# Heading\n\nParagraph with **bold** text.";
    const result = textToMarkdown(text);
    expect(result).toBe(text);
  });

  it("wraps plain text in code block if needed", () => {
    const text = "Plain text\nwith multiple\nlines";
    const result = textToMarkdown(text);
    // Should detect it's not markdown and wrap
    expect(result).toContain("```");
  });

  it("handles empty text", () => {
    const result = textToMarkdown("");
    expect(result).toBe("");
  });
});

describe("pdfToMarkdown", () => {
  it("formats PDF text with page breaks", () => {
    const pdfText = "Page 1 content\n\nMore content";
    const result = pdfToMarkdown(pdfText, true);
    // PDF text is returned as-is (page breaks handled by extractPdfContent)
    expect(result).toBe(pdfText);
  });

  it("handles PDF without page breaks option", () => {
    const pdfText = "PDF content";
    const result = pdfToMarkdown(pdfText, false);
    expect(result).toBe("PDF content");
  });

  it("handles empty PDF text", () => {
    const result = pdfToMarkdown("", true);
    expect(result).toBe("");
  });
});

describe("convertToMarkdown", () => {
  it("converts CSV buffer to markdown", async () => {
    const buffer = Buffer.from("id,name\n1,Test", "utf-8");
    const result = await convertToMarkdown(buffer, "csv", "test.csv");
    expect(result).toContain("| id | name |");
  });

  it("converts JSON buffer to markdown", async () => {
    const buffer = Buffer.from('{"key":"value"}', "utf-8");
    const result = await convertToMarkdown(buffer, "json", "test.json");
    expect(result).toContain("```json");
  });

  it("converts text buffer to markdown", async () => {
    const buffer = Buffer.from("Plain text", "utf-8");
    const result = await convertToMarkdown(buffer, "text", "test.txt");
    expect(result).toContain("```");
  });

  it("converts PDF buffer to markdown", async () => {
    const buffer = Buffer.from("PDF content", "utf-8");
    const result = await convertToMarkdown(buffer, "pdf", "test.pdf");
    expect(result).toBe("PDF content");
  });
});
