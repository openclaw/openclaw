import { describe, expect, it } from "vitest";

import {
  chunkSections,
  estimateTokens,
  parseMarkdownSections,
  semanticChunk,
} from "./semantic-chunker.js";

describe("estimateTokens", () => {
  it("estimates roughly 1 token per 4 chars", () => {
    expect(estimateTokens("1234")).toBe(1);
    expect(estimateTokens("12345678")).toBe(2);
    expect(estimateTokens("")).toBe(0);
  });
});

describe("parseMarkdownSections", () => {
  it("extracts sections from simple markdown", () => {
    const md = `# Title
Content under title

## Section
More content`;
    const sections = parseMarkdownSections(md);
    expect(sections).toHaveLength(2);
    expect(sections[0]?.heading).toBe("Title");
    expect(sections[0]?.level).toBe(1);
    expect(sections[0]?.content).toContain("Content under title");
    expect(sections[1]?.heading).toBe("Section");
    expect(sections[1]?.level).toBe(2);
  });

  it("handles content before any heading", () => {
    const md = `Some intro text

# First Heading
Content`;
    const sections = parseMarkdownSections(md);
    expect(sections).toHaveLength(2);
    expect(sections[0]?.heading).toBe("");
    expect(sections[0]?.level).toBe(0);
    expect(sections[0]?.content).toBe("Some intro text");
  });

  it("detects code content type", () => {
    const md = `# Code Example
\`\`\`javascript
const x = 1;
\`\`\``;
    const sections = parseMarkdownSections(md);
    expect(sections[0]?.contentType).toBe("code");
  });

  it("detects list content type", () => {
    const md = `# Shopping List
- Apples
- Bananas
- Oranges`;
    const sections = parseMarkdownSections(md);
    expect(sections[0]?.contentType).toBe("list");
  });

  it("detects table content type", () => {
    const md = `# Data Table
| Name | Value |
|------|-------|
| A    | 1     |`;
    const sections = parseMarkdownSections(md);
    expect(sections[0]?.contentType).toBe("table");
  });

  it("detects mixed content type", () => {
    const md = `# Mixed
Some text
\`\`\`js
code
\`\`\`
- list item`;
    const sections = parseMarkdownSections(md);
    expect(sections[0]?.contentType).toBe("mixed");
  });

  it("handles empty sections", () => {
    const md = `# Empty

# Also Empty`;
    const sections = parseMarkdownSections(md);
    // Empty sections with just heading should still be captured
    expect(sections.length).toBeGreaterThanOrEqual(1);
  });
});

describe("chunkSections", () => {
  it("keeps small sections as single chunks", () => {
    const sections = [
      {
        heading: "Small",
        level: 1,
        content: "Brief content",
        startLine: 1,
        endLine: 2,
        contentType: "prose" as const,
      },
    ];

    const chunks = chunkSections(sections, {
      maxTokens: 600,
      minTokens: 10,
      includeHeadingContext: true,
    });

    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.isComplete).toBe(true);
    expect(chunks[0]?.text).toContain("# Small");
  });

  it("splits large sections at paragraph boundaries", () => {
    const longContent = Array(10)
      .fill("This is a paragraph with enough words to take up some tokens.")
      .join("\n\n");

    const sections = [
      {
        heading: "Long",
        level: 1,
        content: longContent,
        startLine: 1,
        endLine: 20,
        contentType: "prose" as const,
      },
    ];

    const chunks = chunkSections(sections, {
      maxTokens: 100, // Force splitting
      minTokens: 10,
      includeHeadingContext: true,
    });

    expect(chunks.length).toBeGreaterThan(1);
  });

  it("maintains heading breadcrumb through nested sections", () => {
    const sections = [
      {
        heading: "Main",
        level: 1,
        content: "Main content",
        startLine: 1,
        endLine: 2,
        contentType: "prose" as const,
      },
      {
        heading: "Sub",
        level: 2,
        content: "Sub content",
        startLine: 3,
        endLine: 4,
        contentType: "prose" as const,
      },
    ];

    const chunks = chunkSections(sections, {
      maxTokens: 600,
      minTokens: 10,
      includeHeadingContext: true,
    });

    expect(chunks).toHaveLength(2);
    expect(chunks[0]?.headingBreadcrumb).toEqual(["Main"]);
    expect(chunks[1]?.headingBreadcrumb).toEqual(["Main", "Sub"]);
  });

  it("filters out tiny chunks", () => {
    const sections = [
      {
        heading: "",
        level: 0,
        content: "Hi", // Very short
        startLine: 1,
        endLine: 1,
        contentType: "prose" as const,
      },
    ];

    const chunks = chunkSections(sections, {
      maxTokens: 600,
      minTokens: 50, // Higher than "Hi"
      includeHeadingContext: true,
    });

    expect(chunks).toHaveLength(0);
  });
});

describe("semanticChunk", () => {
  it("chunks simple markdown correctly", () => {
    const md = `# Title
This is the introduction.

## Section One
Content for section one.

## Section Two  
Content for section two.`;

    const chunks = semanticChunk(md);

    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks.some((c) => c.text.includes("Title"))).toBe(true);
  });

  it("respects maxTokens option", () => {
    const longMd = `# Long Document
${"Word ".repeat(500)}`;

    const chunks = semanticChunk(longMd, { maxTokens: 200 });

    expect(chunks.length).toBeGreaterThan(1);
    chunks.forEach((chunk) => {
      expect(estimateTokens(chunk.text)).toBeLessThanOrEqual(250); // Some buffer for heading
    });
  });

  it("handles markdown without headings", () => {
    const md = `Just some plain text without any headings.

Another paragraph here.`;

    const chunks = semanticChunk(md);

    expect(chunks.length).toBeGreaterThanOrEqual(1);
    expect(chunks[0]?.headingBreadcrumb).toEqual([]);
  });

  it("preserves code blocks intact when possible", () => {
    const md = `# Code
\`\`\`javascript
function hello() {
  console.log("Hello");
}
\`\`\``;

    const chunks = semanticChunk(md, { maxTokens: 600 });

    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.text).toContain("```javascript");
    expect(chunks[0]?.text).toContain("```");
    expect(chunks[0]?.contentType).toBe("code");
  });

  it("includes heading context when enabled", () => {
    const md = `# Main
Content`;

    const withContext = semanticChunk(md, { includeHeadingContext: true });
    const withoutContext = semanticChunk(md, { includeHeadingContext: false });

    expect(withContext[0]?.text).toContain("# Main");
    expect(withoutContext[0]?.text).not.toContain("# Main");
  });
});
