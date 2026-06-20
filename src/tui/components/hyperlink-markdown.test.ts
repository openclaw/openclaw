import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { stripAnsi } from "../../../packages/terminal-core/src/ansi.js";
import { markdownTheme } from "../theme/theme.js";
import { HyperlinkMarkdown } from "./hyperlink-markdown.js";

const plainLines = (lines: string[]) => lines.map((line) => stripAnsi(line).trimEnd());

describe("HyperlinkMarkdown", () => {
  it("keeps fenced code identifiers intact while respecting narrow terminal width", () => {
    const markdown = new HyperlinkMarkdown(
      ["```python", 'if __name__ == "__main__":', "    main()", "```"].join("\n"),
      0,
      0,
      markdownTheme,
    );

    const rendered = plainLines(markdown.render(12));

    expect(rendered.every((line) => visibleWidth(line) <= 12)).toBe(true);
    expect(rendered).toContain("  __name__");
    expect(rendered).toContain('  __main__":');
    expect(rendered).not.toContain("  __name_");
  });

  it("keeps long fenced code info strings within narrow terminal width", () => {
    const markdown = new HyperlinkMarkdown(
      ["```this-is-a-very-long-language-info-string", "x", "```"].join("\n"),
      0,
      0,
      markdownTheme,
    );

    const rendered = plainLines(markdown.render(12));

    expect(rendered.every((line) => visibleWidth(line) <= 12)).toBe(true);
    expect(rendered.join("\n")).toContain("this-is-a");
  });

  it("keeps fenced code borders nested inside markdown containers", () => {
    const markdown = new HyperlinkMarkdown(
      ["- item", "  ```ts", "  const value = 1;", "  ```", "- next"].join("\n"),
      0,
      0,
      markdownTheme,
    );

    const rendered = plainLines(markdown.render(12));

    expect(rendered.every((line) => visibleWidth(line) <= 12)).toBe(true);
    expect(rendered).toContain("  ```ts");
    expect(rendered).toContain("  ```");
    expect(rendered).not.toContain("```ts");
  });
});
