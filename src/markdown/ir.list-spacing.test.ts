import { describe, it, expect } from "vitest";
import { markdownToIR } from "./ir.js";

describe("list paragraph spacing", () => {
  it("adds blank line between bullet list and following paragraph", () => {
    const input = `- item 1
- item 2

Paragraph after`;
    const result = markdownToIR(input);
    // Should have two newlines between "item 2" and "Paragraph"
    expect(result.text).toContain("item 2\n\nParagraph");
  });

  it("adds blank line between ordered list and following paragraph", () => {
    const input = `1. item 1
2. item 2

Paragraph after`;
    const result = markdownToIR(input);
    expect(result.text).toContain("item 2\n\nParagraph");
  });

  it("does not produce triple newlines", () => {
    const input = `- item 1
- item 2

Paragraph after`;
    const result = markdownToIR(input);
    // Should NOT have three consecutive newlines
    expect(result.text).not.toContain("\n\n\n");
  });
});
