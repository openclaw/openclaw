import { describe, expect, it } from "vitest";
import { convertMarkdownTables } from "./tables.js";

describe("convertMarkdownTables", () => {
  it("preserves headings as hash syntax when headingStyle is hash", () => {
    const md = [
      "# Main Title",
      "",
      "Some intro text.",
      "",
      "| Col A | Col B |",
      "|-------|-------|",
      "| 1     | 2     |",
      "",
      "## Sub Heading",
      "",
      "More text.",
    ].join("\n");

    const result = convertMarkdownTables(md, "bullets", {
      headingStyle: "hash",
    });

    expect(result).toContain("# Main Title");
    expect(result).toContain("## Sub Heading");
  });

  it("preserves blockquotes when blockquotePrefix is set", () => {
    const md = [
      "> This is a quote",
      "",
      "| Col A | Col B |",
      "|-------|-------|",
      "| 1     | 2     |",
    ].join("\n");

    const result = convertMarkdownTables(md, "bullets", {
      blockquotePrefix: "> ",
    });

    expect(result).toContain("> This is a quote");
  });

  it("strips headings by default when tables are present", () => {
    const md = ["# Title", "", "| Col A | Col B |", "|-------|-------|", "| 1     | 2     |"].join(
      "\n",
    );

    const result = convertMarkdownTables(md, "bullets");

    // Default behavior: headingStyle "none" strips the # prefix
    expect(result).not.toMatch(/^# Title/m);
    expect(result).toContain("Title");
  });

  it("preserves heading levels (h1-h3) with hash style", () => {
    const md = ["# H1", "", "## H2", "", "### H3", "", "| A | B |", "|---|---|", "| 1 | 2 |"].join(
      "\n",
    );

    const result = convertMarkdownTables(md, "bullets", {
      headingStyle: "hash",
    });

    expect(result).toContain("# H1");
    expect(result).toContain("## H2");
    expect(result).toContain("### H3");
  });

  it("returns original markdown when no tables are present regardless of options", () => {
    const md = "# Title\n\nSome text\n\n> A quote";

    const result = convertMarkdownTables(md, "bullets", {
      headingStyle: "hash",
      blockquotePrefix: "> ",
    });

    // No tables → original markdown returned unchanged
    expect(result).toBe(md);
  });
});
