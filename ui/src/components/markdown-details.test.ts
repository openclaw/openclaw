import { describe, expect, it } from "vitest";
import { toSanitizedMarkdownHtml, toStreamingMarkdownParts } from "./markdown.ts";

function htmlFragment(html: string): DocumentFragment {
  return document.createRange().createContextualFragment(html);
}

describe("model-authored details blocks", () => {
  it("escapes unsupported openers while continuing to scan later valid tags", () => {
    const html = toSanitizedMarkdownHtml(
      '<details><summary>Outer</summary><details class="x">inner</details>after</details>',
    );
    const fragment = htmlFragment(html);
    const details = fragment.querySelectorAll("details");

    expect(details).toHaveLength(1);
    expect(details[0]?.textContent).toContain('<details class="x">');
    expect(details[0]?.textContent).not.toContain("after");
    expect(fragment.textContent).toContain("after</details>");
    expect(html).not.toContain("&lt;details&gt;&lt;summary&gt;Outer");
  });

  it("keeps an unterminated details block in the repaired streaming tail", () => {
    const html = toStreamingMarkdownParts(
      "Intro\n\n<details open>\n<summary>More</summary>\n\n**partial body",
    ).join("");
    const fragment = htmlFragment(html);
    const details = fragment.querySelector("details");

    expect(fragment.querySelector("p")?.textContent).toBe("Intro");
    expect(details?.hasAttribute("open")).toBe(true);
    expect(details?.querySelector("summary")?.textContent).toBe("More");
    expect(details?.querySelector("strong")?.textContent).toBe("partial body");
    expect(html).not.toContain("&lt;details");
    expect(html).not.toContain("&lt;/details");
    expect(details?.textContent).not.toContain("</details>");
  });

  it.each([
    ["<details><summary>First</summary>\n<summary>Second", ["First"], "<summary>Second"],
  ] as const)("repairs only an eligible final summary: %s", (source, summaries, literal) => {
    const fragment = htmlFragment(toStreamingMarkdownParts(source).join(""));

    expect([...fragment.querySelectorAll("summary")].map((entry) => entry.textContent)).toEqual(
      summaries,
    );
    expect(fragment.textContent).not.toContain("</summary>");
    if (literal) {
      expect(fragment.textContent).toContain(literal);
    }
  });

  it("keeps completed code fences inside an open details streaming tail", () => {
    const html = toStreamingMarkdownParts(
      "<details>\n<summary>Logs</summary>\n\n~~~ts\nconst value = 1;\n~~~\n\nstill streaming",
    ).join("");
    const fragment = htmlFragment(html);
    const details = fragment.querySelector("details");

    expect(details?.querySelector("code.language-ts")?.textContent).toContain("const value = 1;");
    expect(details?.textContent).toContain("still streaming");
    expect([...fragment.children]).toHaveLength(1);
  });
});

describe("multi-token details shapes", () => {
  it.each([
    ["processing instruction", "<?pi\n</details>\n?>"],
    ["CDATA", "<![CDATA[\n</details>\n]]>"],
  ] as const)("keeps closer-shaped text inside an embedded raw HTML %s literal", (_name, raw) => {
    const html = toSanitizedMarkdownHtml(
      `<details>\n<summary>X</summary>\n\n<div>\n${raw}\n</div>\n</details>\n\nFollowing`,
    );
    const fragment = htmlFragment(html);
    const details = fragment.querySelector("details");

    expect(details?.textContent).toContain("</details>");
    expect(details?.textContent).not.toContain("Following");
    expect(fragment.lastElementChild?.textContent).toBe("Following");
  });

  it.each([
    ["comment", "<!--\n</details>\n-->"],
    ["lowercase declaration", "<!doctype\n</details>\n>"],
  ])("keeps body after a raw %s inside streaming details", (_name, raw) => {
    const pending = `<details>\n<summary>X</summary>\n\n<div>\n${raw}\n</div>\n\nStill inside`;
    const completed = `${pending}\n</details>\n\nFollowing`;
    for (const source of [pending, completed]) {
      for (const html of [
        toSanitizedMarkdownHtml(source),
        toStreamingMarkdownParts(source).join(""),
      ]) {
        const fragment = htmlFragment(html);
        const details = fragment.querySelector("details");
        expect(details?.textContent).toContain("</details>");
        expect(details?.textContent).toContain("Still inside");
        expect(details?.textContent).not.toContain("Following");
        if (source === completed) {
          expect(fragment.lastElementChild?.textContent).toBe("Following");
        }
      }
    }
  });

  it.each([
    {
      opener: "<pre>",
      container: "list continuation",
      raw: "- item\n\n  <pre>\n  **literal",
      suffix: "**outside",
      selector: "strong",
      text: "outside",
    },
  ])(
    "resumes $text after an unfinished $opener leaves its $container",
    ({ raw, suffix, selector, text }) => {
      const source = `<details>\n<summary>X</summary>\n\n${raw}\n\n</details>\n\n${suffix}`;
      const fragment = htmlFragment(toStreamingMarkdownParts(source).join(""));
      expect(fragment.querySelector("details")?.textContent).toContain("**literal");
      expect(fragment.querySelector("details")?.textContent).not.toContain(text);
      expect(fragment.querySelector(selector)?.textContent).toBe(text);
    },
  );

  it.each([["pre", "<pre>\n</details>\n</pre>"]])(
    "keeps a raw %s code sample from owning a later summary",
    (_name, raw) => {
      const opener = raw.slice(0, raw.indexOf("\n"));
      const source = `    ${opener}\n\n<details>\n<summary>Actual`;
      const fragment = htmlFragment(toStreamingMarkdownParts(source).join(""));
      expect(fragment.querySelector("code")?.textContent).toBe(`${opener}\n`);
      expect(fragment.querySelector("details summary")?.textContent).toBe("Actual");
    },
  );

  it.each([
    {
      context: "pre",
      raw: "<pre>\n</details>\n</pre>",
      syntax: "inline code",
      delimiter: "`",
      tag: "code",
      closed: false,
    },
  ])(
    "keeps $syntax literal in a $context block (closed=$closed)",
    ({ raw, delimiter, tag, closed }) => {
      const rawBlock = raw.replace("</details>", `${delimiter}literal`);
      const literal = closed ? rawBlock : rawBlock.slice(0, rawBlock.lastIndexOf("\n"));
      const source = `<details>\n<summary>X</summary>\n\n${literal}${closed ? `\n${delimiter}outside` : ""}`;
      const details = htmlFragment(toStreamingMarkdownParts(source).join("")).querySelector(
        "details",
      );
      expect(details?.textContent).toContain(literal);
      if (closed) {
        expect(details?.querySelector(tag)?.textContent).toBe("outside");
      } else {
        const staticDetails = htmlFragment(toSanitizedMarkdownHtml(source)).querySelector(
          "details",
        );
        expect(details?.textContent).toBe(staticDetails?.textContent);
      }
    },
  );
});

describe("details line-start contract", () => {
  it("keeps inline-code, prose, and task-item occurrences escaped", () => {
    const html = toSanitizedMarkdownHtml(
      [
        "`<details><summary>code</summary>body</details>`",
        "",
        "prose <details><summary>inline</summary>body</details>",
        "",
        "- [ ] <details><summary>task</summary>body</details>",
      ].join("\n"),
    );
    const fragment = htmlFragment(html);

    expect(fragment.querySelector("details")).toBeNull();
    expect(fragment.querySelector("code")?.textContent).toContain("<details>");
    expect(fragment.querySelector("li")?.textContent).toContain("<details>");
    expect(fragment.textContent).toContain("prose <details>");
  });

  it("keeps escaped disclosure tags on a structural line literal", () => {
    const html = toSanitizedMarkdownHtml(
      "<details><summary>A</summary>\\</details> still inside</details>",
    );
    const fragment = htmlFragment(html);
    const details = fragment.querySelector("details");

    expect(details?.textContent).toContain("</details> still inside");
    expect(fragment.querySelectorAll("details")).toHaveLength(1);
  });

  it("does not repair disclosure-shaped indented code while streaming", () => {
    const html = toStreamingMarkdownParts("before\n\n    <details>\n    <summary>literal").join("");
    const code = htmlFragment(html).querySelector("code");

    expect(code?.textContent).toBe("<details>\n<summary>literal\n");
    expect(code?.textContent).not.toContain("</summary>");
  });
});
