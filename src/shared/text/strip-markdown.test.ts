import { describe, expect, it } from "vitest";
import { stripMarkdown } from "./strip-markdown.js";

describe("stripMarkdown", () => {
  // --- bold ----------------------------------------------------------------

  it("strips **bold** markers", () => {
    expect(stripMarkdown("this is **bold** text")).toBe("this is bold text");
  });

  it("strips __bold__ markers", () => {
    expect(stripMarkdown("this is __bold__ text")).toBe("this is bold text");
  });

  // --- italic --------------------------------------------------------------

  it("strips *italic* markers", () => {
    expect(stripMarkdown("this is *italic* text")).toBe("this is italic text");
  });

  it("strips _italic_ markers", () => {
    expect(stripMarkdown("this is _italic_ text")).toBe("this is italic text");
  });

  // --- strikethrough -------------------------------------------------------

  it("strips ~~strikethrough~~ markers", () => {
    expect(stripMarkdown("this is ~~deleted~~ text")).toBe("this is deleted text");
  });

  // --- headings ------------------------------------------------------------

  it("strips heading markers", () => {
    expect(stripMarkdown("# Title")).toBe("Title");
    expect(stripMarkdown("## Subtitle")).toBe("Subtitle");
    expect(stripMarkdown("###### Deep heading")).toBe("Deep heading");
  });

  it("preserves mid-line hash symbols", () => {
    expect(stripMarkdown("issue #42 is open")).toBe("issue #42 is open");
  });

  // --- blockquotes ---------------------------------------------------------

  it("strips blockquote markers", () => {
    expect(stripMarkdown("> quoted text")).toBe("quoted text");
    expect(stripMarkdown(">no space")).toBe("no space");
  });

  // --- inline code ---------------------------------------------------------

  it("strips inline code backticks", () => {
    expect(stripMarkdown("run `npm install` now")).toBe("run npm install now");
  });

  // --- horizontal rules ----------------------------------------------------

  it("removes horizontal rules", () => {
    expect(stripMarkdown("above\n---\nbelow")).toBe("above\n\nbelow");
    expect(stripMarkdown("above\n***\nbelow")).toBe("above\n\nbelow");
  });

  // --- code blocks (NEW) ---------------------------------------------------

  it("strips fenced code blocks", () => {
    expect(stripMarkdown("before\n```\ncode here\n```\nafter")).toBe("before\ncode here\nafter");
  });

  it("strips fenced code blocks with language tag", () => {
    expect(stripMarkdown("before\n```typescript\nconst x = 1;\n```\nafter")).toBe(
      "before\nconst x = 1;\nafter",
    );
  });

  // --- bullet points (NEW) ------------------------------------------------

  it("strips dash bullet points", () => {
    expect(stripMarkdown("- first item\n- second item")).toBe("first item\nsecond item");
  });

  it("strips asterisk bullet points", () => {
    expect(stripMarkdown("* first item\n* second item")).toBe("first item\nsecond item");
  });

  // --- numbered lists (NEW) ------------------------------------------------

  it("strips numbered list markers", () => {
    expect(stripMarkdown("1. first\n2. second\n3. third")).toBe("first\nsecond\nthird");
  });

  // --- links (NEW) ---------------------------------------------------------

  it("converts links to plain text", () => {
    expect(stripMarkdown("see [the docs](https://example.com) here")).toBe("see the docs here");
  });

  it("preserves bare URLs", () => {
    expect(stripMarkdown("visit https://example.com today")).toBe(
      "visit https://example.com today",
    );
  });

  // --- edge cases ----------------------------------------------------------

  it("passes through plain text unchanged", () => {
    expect(stripMarkdown("just normal text")).toBe("just normal text");
  });

  it("handles empty string", () => {
    expect(stripMarkdown("")).toBe("");
  });

  it("preserves asterisks in math expressions", () => {
    expect(stripMarkdown("2 * 3 = 6")).toBe("2 * 3 = 6");
  });

  it("collapses excessive newlines", () => {
    expect(stripMarkdown("a\n\n\n\nb")).toBe("a\n\nb");
  });

  it("handles realistic LLM output", () => {
    const input = [
      "## Summary",
      "",
      "Here's what happened:",
      "",
      "- **First thing** was done",
      "- The `second` thing failed",
      "- See [details](https://example.com)",
      "",
      "```bash",
      "npm install",
      "```",
    ].join("\n");

    const expected = [
      "Summary",
      "",
      "Here's what happened:",
      "",
      "First thing was done",
      "The second thing failed",
      "See details",
      "",
      "npm install",
    ].join("\n");

    expect(stripMarkdown(input)).toBe(expected);
  });
});
