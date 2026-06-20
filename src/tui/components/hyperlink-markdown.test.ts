import { describe, expect, it } from "vitest";
import { stripAnsi } from "../../../packages/terminal-core/src/ansi.js";
import { markdownTheme } from "../theme/theme.js";
import { HyperlinkMarkdown } from "./hyperlink-markdown.js";

const plainLines = (lines: string[]) => lines.map((line) => stripAnsi(line).trimEnd());

describe("HyperlinkMarkdown", () => {
  it("keeps fenced code lines verbatim when the terminal is narrow", () => {
    const markdown = new HyperlinkMarkdown(
      ["```python", 'if __name__ == "__main__":', "    main()", "```"].join("\n"),
      0,
      0,
      markdownTheme,
    );

    const rendered = plainLines(markdown.render(12));

    expect(rendered).toContain('  if __name__ == "__main__":');
    expect(rendered).not.toContain("__name_");
  });
});
