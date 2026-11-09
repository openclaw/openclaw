import { describe, expect, it } from "vitest";
import { htmlFragment } from "./markdown.test-support.ts";
import { toSanitizedMarkdownHtml } from "./markdown.ts";

describe("CJK-friendly Markdown", () => {
  it.each([{ markdown: "**「先端の記述子」**のが重要", strong: "「先端の記述子」" }])(
    "renders punctuation-adjacent emphasis in $markdown",
    ({ markdown, strong }) => {
      const fragment = htmlFragment(toSanitizedMarkdownHtml(markdown));
      expect(fragment.querySelector("strong")?.textContent).toBe(strong);
      expect(fragment.textContent).not.toContain("**");
    },
  );
});

describe("safe Markdown HTML", () => {
  it("renders a line break inside a table cell", () => {
    const fragment = htmlFragment(
      toSanitizedMarkdownHtml(["| Language |", "| --- |", "| 一<BR />二 |"].join("\n")),
    );
    const cell = fragment.querySelector("tbody td");
    expect(cell?.querySelectorAll("br")).toHaveLength(1);
    expect(cell?.textContent).toBe("一二");
  });

  it("renders a line break between blocks", () => {
    expect(toSanitizedMarkdownHtml("before\n\n<br>\n\nafter")).toBe(
      "<p>before</p>\n<br>\n<p>after</p>\n",
    );
  });

  it.each(['<br onclick="alert(1)">'])("escapes untrusted markup %s", (markup) => {
    const fragment = htmlFragment(toSanitizedMarkdownHtml(markup));
    expect(fragment.querySelector("br")).toBeNull();
    expect(fragment.textContent).toContain(markup);
    expect(fragment.querySelector("script")).toBeNull();
  });
});
