import { describe, expect, it } from "vitest";
import { htmlFragment, toStreamingMarkdownParts } from "./markdown.test-support.ts";
import { toSanitizedMarkdownHtml } from "./markdown.ts";

const links = Array.from(
  { length: 8 },
  (_, i) =>
    `[Fix session memory usage · Pull Request #${i + 101} · GitHub](https://github.com/example/project/pull/${i + 101})`,
).join(" ");

const renderers = [
  toSanitizedMarkdownHtml,
  (text: string) => toStreamingMarkdownParts(text).join(""),
];

describe("GitHub source footer", () => {
  it("keeps all trailing sources comma-separated without losing descriptive names", () => {
    for (const render of renderers) {
      const fragment = htmlFragment(
        render(`Answer with [an inline link](https://github.com/example/project/pull/100).

${links}`),
      );
      const footer = fragment.querySelector("p:last-child")!;
      expect(footer).not.toBeNull();
      expect(footer.querySelectorAll("div, br, details, summary")).toHaveLength(0);
      expect(footer.textContent).toBe(
        Array.from({ length: 8 }, (_, i) => `#${i + 101}`).join(", "),
      );
      expect(footer.querySelectorAll("a")).toHaveLength(8);
      expect(footer.querySelector("a")?.textContent).toBe("#101");
      expect(footer.querySelector("a")?.getAttribute("aria-label")).toContain(
        "Fix session memory usage",
      );
      expect(footer.querySelector("details")).toBeNull();
      expect(fragment.querySelector("p a")?.textContent).toBe("an inline link");
    }
  });

  it("preserves repository identity, mixed sources, and small-list titles", () => {
    const mixed =
      links +
      " [Other repository](https://github.com/other/project/issues/101) [Docs](https://docs.example.com/guide)";
    const footer = htmlFragment(toSanitizedMarkdownHtml(mixed)).querySelector("p:last-child")!;
    expect(footer.querySelector("a")?.textContent).toBe("example/project#101");
    expect(footer.querySelector('a[href*="other/project"]')?.textContent).toBe("other/project#101");
    expect(footer.querySelector('a[href*="docs.example"]')?.textContent).toBe("Docs");
    const pair =
      "[First fix](https://github.com/example/project/pull/1) [Second fix](https://github.com/example/project/pull/2)";
    const short = htmlFragment(toSanitizedMarkdownHtml(pair));
    expect(short.querySelectorAll("p:last-child a")).toHaveLength(2);
    expect(short.querySelector("a")?.textContent).toBe("First fix");
    expect(short.querySelector("details")).toBeNull();
  });

  it.each([4, 5])("shortens only when the source count reaches five (%s)", (count) => {
    const sources = Array.from(
      { length: count },
      (_, i) => `[Fix ${i + 1}](https://github.com/example/project/pull/${i + 1})`,
    );
    for (const render of renderers) {
      const footer = htmlFragment(render(sources.join("\n"))).querySelector("p:last-child")!;
      expect(footer.textContent).toBe(
        sources.map((_, i) => (count >= 5 ? `#${i + 1}` : `Fix ${i + 1}`)).join(", "),
      );
      expect(footer.querySelector("br, details")).toBeNull();
    }
  });

  it("leaves prose, nested content, and documents alone", () => {
    for (const text of [
      `See these sources: ${links}`,
      `${links}

More prose.`,
      `> ${links}`,
      `https://github.com/example/project/pull/99 ${links}

More prose.`,
    ]) {
      for (const render of renderers) {
        expect(htmlFragment(render(text)).querySelector('a[href$="/pull/101"]')?.textContent).toBe(
          "Fix session memory usage · Pull Request #101 · GitHub",
        );
      }
    }
    expect(
      htmlFragment(toSanitizedMarkdownHtml(links, { mode: "document" })).querySelector(
        'a[href$="/pull/101"]',
      )?.textContent,
    ).toBe("Fix session memory usage · Pull Request #101 · GitHub");
  });
});
