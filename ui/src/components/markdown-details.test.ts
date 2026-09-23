import { describe, expect, it } from "vitest";
import { toSanitizedMarkdownHtml, toStreamingMarkdownParts } from "./markdown.ts";

function htmlFragment(html: string): DocumentFragment {
  return document.createRange().createContextualFragment(html);
}

const rawHtmlStreamingContexts = [
  ["comment", "<!--\n</details>\n-->"],
  ["pre", "<pre>\n</details>\n</pre>"],
  ["lowercase declaration", "<!doctype\n</details>\n>"],
] as const;

describe("model-authored details blocks", () => {
  it("renders block-level details with nested markdown", () => {
    const html = toSanitizedMarkdownHtml(
      [
        "<details open>",
        "",
        "<summary>Optional depth</summary>",
        "",
        "**Bold body**",
        "",
        "- one",
        "- two",
        "",
        "> quoted body",
        "",
        "```ts",
        "const value = 1;",
        "```",
        "</details>",
      ].join("\n"),
    );
    const fragment = htmlFragment(html);
    const details = fragment.querySelector("details");

    expect(details?.hasAttribute("open")).toBe(true);
    expect(details?.querySelector("summary")?.textContent).toBe("Optional depth");
    expect(details?.querySelector("strong")?.textContent).toBe("Bold body");
    expect([...(details?.querySelectorAll("li") ?? [])].map((item) => item.textContent)).toEqual([
      "one",
      "two",
    ]);
    expect(details?.querySelector("blockquote")?.textContent?.trim()).toBe("quoted body");
    expect(details?.querySelector("code.language-ts")?.textContent).toContain("const value = 1;");
  });

  it("renders a compact details block while escaping HTML in its body", () => {
    const html = toSanitizedMarkdownHtml(
      "<details><summary>More</summary>**bold** <script>nope</script></details>",
    );
    const fragment = htmlFragment(html);

    expect(fragment.querySelector("details summary")?.textContent).toBe("More");
    expect(fragment.querySelector("details strong")?.textContent).toBe("bold");
    expect(fragment.querySelector("script")).toBeNull();
    expect(fragment.querySelector("details")?.textContent).toContain("<script>nope</script>");
  });

  it.each([false, true])("consumes summary labels before nesting (streaming=%s)", (streaming) => {
    const source =
      "<details><summary>Outer </details><details> label</summary>" +
      "<details><summary>Inner</summary>body</details>tail</details>\n\noutside";
    const fragment = htmlFragment(
      streaming ? toStreamingMarkdownParts(source).join("") : toSanitizedMarkdownHtml(source),
    );
    const details = fragment.querySelectorAll("details");

    expect(details).toHaveLength(2);
    expect([...details].map((entry) => entry.querySelector("summary")?.textContent)).toEqual([
      "Outer </details><details> label",
      "Inner",
    ]);
    expect(details[1]?.querySelector("p")?.textContent).toBe("body");
    expect(details[1]?.textContent).not.toContain("tail");
    expect(details[0]?.textContent).toContain("tail");
    expect(details[0]?.textContent).not.toContain("outside");
    expect(fragment.lastElementChild?.textContent).toBe("outside");
  });

  it("keeps large runs of disclosure tags literal inside fenced code", () => {
    const count = 2_000;
    const literals = Array.from({ length: count }, () => "</details>").join("\n");
    const html = toSanitizedMarkdownHtml(
      `<details><summary>Examples</summary>\n\n\`\`\`html\n${literals}\n\`\`\`\n\n</details>`,
    );
    const code = htmlFragment(html).querySelector("details code");

    expect(code?.textContent?.match(/<\/details>/g)).toHaveLength(count);
  });

  it("caps deeply nested details at 32 tags on one line", () => {
    let markdown = "deep body";
    for (let index = 0; index < 48; index += 1) {
      markdown = `<details><summary>Level ${index}</summary>${markdown}</details>`;
    }

    const html = toSanitizedMarkdownHtml(markdown);
    const fragment = htmlFragment(html);

    expect(fragment.querySelectorAll("details")).toHaveLength(32);
    expect(fragment.textContent).toContain("<details>");
  });

  it("caps deeply nested details across lines", () => {
    const lines: string[] = [];
    for (let index = 0; index < 48; index += 1) {
      lines.push("<details>", `<summary>Level ${index}</summary>`, "");
    }
    lines.push("deep body");
    for (let index = 0; index < 48; index += 1) {
      lines.push("", "</details>");
    }

    const html = toSanitizedMarkdownHtml(lines.join("\n"));
    const fragment = htmlFragment(html);

    expect(fragment.querySelectorAll("details")).toHaveLength(32);
    expect(fragment.textContent).toContain("<details>");
  });

  it("applies the depth cap to every opener on a matched line", () => {
    const markdown = `${Array.from({ length: 24 }, () => "<details><details>").join("\n\n")}\n\ndeep body`;
    const html = toSanitizedMarkdownHtml(markdown);
    const fragment = htmlFragment(html);

    expect(fragment.querySelectorAll("details")).toHaveLength(32);
    expect(fragment.textContent).toContain("<details>");
  });

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
    ["<details>\n<summary>Still arriving", ["Still arriving"], null],
    ["<details>\n<summary>Literal\n", [], "<summary>Literal"],
    ["<details><summary>Outer</summary>\n<details><summary>Inner", ["Outer", "Inner"], null],
    ["<summary>Orphan", [], "<summary>Orphan"],
    ["<details><summary>First</summary>\n<summary>Second", ["First"], "<summary>Second"],
    ["<details>\n<summary>Earlier\nbody", [], "<summary>Earlier"],
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

  it("repairs prose after a closed fence and details block without a blank line", () => {
    const html = toStreamingMarkdownParts(
      "<details>\n<summary>Logs</summary>\n\n```ts\nconst value = 1;\n```\n</details>\ncontinuing **now",
    ).join("");
    const fragment = htmlFragment(html);

    expect(fragment.querySelector("details code.language-ts")?.textContent).toContain(
      "const value = 1;",
    );
    expect(fragment.querySelector("p:last-child strong")?.textContent).toBe("now");
  });

  it("repairs an unterminated summary after a closed fence and details block", () => {
    const html = toStreamingMarkdownParts(
      "<details>\n<summary>Logs</summary>\n\n```ts\nconst value = 1;\n```\n</details>\n<details>\n<summary>Still arriving",
    ).join("");
    const details = htmlFragment(html).querySelectorAll("details");

    expect(details).toHaveLength(2);
    expect(details[1]?.querySelector("summary")?.textContent).toBe("Still arriving");
    expect(html).not.toContain("&lt;summary");
  });

  it("stabilizes a completed details block before the live markdown tail", () => {
    const html = toStreamingMarkdownParts(
      "<details><summary>Done</summary>fixed</details>\n\ncontinuing **now",
    ).join("");
    const fragment = htmlFragment(html);

    expect(fragment.querySelector("details summary")?.textContent).toBe("Done");
    expect(fragment.querySelector("details p")?.textContent).toBe("fixed");
    expect(fragment.querySelector("p:last-child strong")?.textContent).toBe("now");
  });

  it("keeps a closed disclosure and its continuation in the same list item", () => {
    const html = toStreamingMarkdownParts(
      "- <details>\n  <summary>Logs</summary>\n\n  body\n  </details>\n  continuing **now",
    ).join("");
    const fragment = htmlFragment(html);
    const listItem = fragment.querySelector("li");

    expect(listItem?.querySelector("details")?.textContent).toContain("body");
    expect(listItem?.querySelector("strong")?.textContent).toBe("now");
    expect(fragment.querySelector(":scope > p")).toBeNull();
  });
});

describe("multi-token details shapes", () => {
  it("parses body blocks normally after an opener and summary share a line", () => {
    const html = toSanitizedMarkdownHtml(
      "<details><summary>More</summary>\nbody **one**\n\nbody two\n</details>",
    );
    const details = htmlFragment(html).querySelector("details");

    expect(details?.querySelector("summary")?.textContent).toBe("More");
    expect(details?.querySelector("strong")?.textContent).toBe("one");
    expect(details?.querySelectorAll("p")).toHaveLength(2);
  });

  it("renders a summary authored after a blank line", () => {
    const html = toSanitizedMarkdownHtml(
      "<details>\n\n<summary>Authored label</summary>\n\nbody\n</details>",
    );
    const details = htmlFragment(html).querySelector("details");

    expect(details?.querySelector("summary")?.textContent).toBe("Authored label");
    expect(details?.textContent).toContain("body");
  });

  it("renders details when body text follows the summary without a blank line", () => {
    const html = toSanitizedMarkdownHtml(
      "<details>\n<summary>More</summary>\nfirst line\n\nsecond paragraph\n</details>",
    );
    const fragment = htmlFragment(html);
    const details = fragment.querySelector("details");

    expect(details?.querySelector("summary")?.textContent).toBe("More");
    expect(details?.textContent).toContain("first line");
    expect(details?.textContent).toContain("second paragraph");
    expect(html).not.toContain("&lt;details");
  });

  it("renders markdown following a closed details block from the same token", () => {
    const html = toSanitizedMarkdownHtml("<details><summary>A</summary>a</details>\ncontinuing");
    const fragment = htmlFragment(html);

    expect(fragment.querySelector("details summary")?.textContent).toBe("A");
    expect(fragment.querySelector("details")?.textContent).toContain("a");
    expect(fragment.lastElementChild?.textContent).toBe("continuing");
    expect(html).not.toContain("&lt;details");
  });

  it("renders consecutive details blocks without a blank line", () => {
    const html = toSanitizedMarkdownHtml(
      "<details><summary>A</summary>a</details>\n<details><summary>B</summary>b</details>",
    );
    const details = htmlFragment(html).querySelectorAll("details");

    expect([...details].map((entry) => entry.querySelector("summary")?.textContent)).toEqual([
      "A",
      "B",
    ]);
    expect([...details].map((entry) => entry.textContent?.trim())).toEqual(["Aa", "Bb"]);
  });

  it("renders more than 32 sibling details blocks and their trailing markdown", () => {
    const siblings = Array.from(
      { length: 40 },
      (_, index) => `<details><summary>Sibling ${index}</summary>body ${index}</details>`,
    ).join("\n");
    const html = toSanitizedMarkdownHtml(`${siblings}\ntrailing **done**`);
    const fragment = htmlFragment(html);
    const details = fragment.querySelectorAll("details");

    expect(details).toHaveLength(40);
    expect(details[39]?.querySelector("summary")?.textContent).toBe("Sibling 39");
    expect(fragment.lastElementChild?.querySelector("strong")?.textContent).toBe("done");
    expect(html).not.toContain("&lt;details");
  });

  it("renders markdown following a standalone details close token", () => {
    const html = toSanitizedMarkdownHtml(
      "<details>\n<summary>A</summary>\n\nbody\n\n</details>\ncontinuing",
    );
    const fragment = htmlFragment(html);
    const details = fragment.querySelector("details");

    expect(details?.textContent).toContain("body");
    expect(details?.textContent).not.toContain("continuing");
    expect(fragment.lastElementChild?.textContent).toBe("continuing");
    expect(html).not.toContain("&lt;/details");
  });

  it("closes before trailing prose when a type-6 HTML block absorbs the closer", () => {
    const html = toSanitizedMarkdownHtml(
      "<details>\n<summary>X</summary>\n\n<div>body</div>\n</details>\n\nFollowing",
    );
    const fragment = htmlFragment(html);
    const details = fragment.querySelector("details");

    expect(details?.textContent).toContain("body");
    expect(details?.textContent).not.toContain("Following");
    expect(fragment.lastElementChild?.textContent).toBe("Following");
  });

  it.each([
    ...rawHtmlStreamingContexts,
    ["script", "<script>\n</details>\n</script>"],
    ["style", "<style>\n</details>\n</style>"],
    ["processing instruction", "<?pi\n</details>\n?>"],
    ["declaration", "<!DOCTYPE\n</details>\n>"],
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

  it.each(rawHtmlStreamingContexts)(
    "keeps body after a raw %s inside streaming details",
    (_name, raw) => {
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
    },
  );

  it.each(
    ["<!--", "<pre>"].flatMap((opener) =>
      [
        ["blockquote", `> ${opener}\n> **literal`],
        ["list continuation", `- item\n\n  ${opener}\n  **literal`],
      ].flatMap(([container, raw]) =>
        [
          { suffix: "**outside", selector: "strong", text: "outside" },
          {
            suffix: "<details>\n<summary>Next",
            selector: "details:last-child summary",
            text: "Next",
          },
        ].map(({ suffix, selector, text }) => ({ opener, container, raw, suffix, selector, text })),
      ),
    ),
  )(
    "resumes $text after an unfinished $opener leaves its $container",
    ({ raw, suffix, selector, text }) => {
      const source = `<details>\n<summary>X</summary>\n\n${raw}\n\n</details>\n\n${suffix}`;
      const fragment = htmlFragment(toStreamingMarkdownParts(source).join(""));
      expect(fragment.querySelector("details")?.textContent).toContain("**literal");
      expect(fragment.querySelector("details")?.textContent).not.toContain(text);
      expect(fragment.querySelector(selector)?.textContent).toBe(text);
    },
  );

  it.each(rawHtmlStreamingContexts)(
    "keeps a raw %s code sample from owning a later summary",
    (_name, raw) => {
      const opener = raw.slice(0, raw.indexOf("\n"));
      const source = `    ${opener}\n\n<details>\n<summary>Actual`;
      const fragment = htmlFragment(toStreamingMarkdownParts(source).join(""));
      expect(fragment.querySelector("code")?.textContent).toBe(`${opener}\n`);
      expect(fragment.querySelector("details summary")?.textContent).toBe("Actual");
    },
  );

  it.each(
    rawHtmlStreamingContexts.flatMap(([context, raw]) =>
      [
        { syntax: "emphasis", delimiter: "**", tag: "strong" },
        { syntax: "inline code", delimiter: "`", tag: "code" },
      ].flatMap(({ syntax, delimiter, tag }) =>
        [false, true].map((closed) => ({ context, raw, syntax, delimiter, tag, closed })),
      ),
    ),
  )(
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

  it.each(rawHtmlStreamingContexts)(
    "keeps unfinished summaries in a raw %s literal while streaming",
    (_name, raw) => {
      const opener = raw.slice(0, raw.indexOf("\n"));
      const source = `<details>\n${opener}\n<summary>literal`;
      for (const html of [
        toSanitizedMarkdownHtml(source),
        toStreamingMarkdownParts(source).join(""),
      ]) {
        const details = htmlFragment(html).querySelector("details");
        expect(details?.querySelector("summary")).toBeNull();
        expect(details?.textContent).toContain("<summary>literal");
        expect(details?.textContent).not.toContain("</summary>");
      }
    },
  );

  it("renders details when body text starts without a summary", () => {
    const html = toSanitizedMarkdownHtml("<details>\nfirst line\n\nsecond paragraph\n</details>");
    const fragment = htmlFragment(html);
    const details = fragment.querySelector("details");

    expect(details?.querySelector("summary")).toBeNull();
    expect(details?.textContent).toContain("first line");
    expect(details?.textContent).toContain("second paragraph");
    expect(html).not.toContain("&lt;details");
  });
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

  it("keeps an open streaming details block intact across inline code", () => {
    const code = "`literal </details> marker`";
    const html = toStreamingMarkdownParts(
      `<details>\n<summary>Example</summary>\n${code}\n\nstill inside`,
    ).join("");
    const fragment = htmlFragment(html);
    const details = fragment.querySelector("details");

    expect(details?.textContent).toContain("literal </details> marker");
    expect(details?.textContent).toContain("still inside");
    expect([...fragment.children]).toHaveLength(1);
  });

  it("keeps disclosure-shaped inline code on a structural line literal", () => {
    const html = toSanitizedMarkdownHtml(
      "<details><summary>A</summary>`literal </details>` still inside</details>",
    );
    const fragment = htmlFragment(html);
    const details = fragment.querySelector("details");

    expect(details?.querySelector("code")?.textContent).toBe("literal </details>");
    expect(details?.textContent).toContain("still inside");
    expect(fragment.querySelectorAll("details")).toHaveLength(1);
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

  it("keeps streaming details intact across an inline prose close tag", () => {
    const html = toStreamingMarkdownParts(
      "<details>\n<summary>A</summary>\nliteral </details> text\n\nstill inside",
    ).join("");
    const fragment = htmlFragment(html);
    const details = fragment.querySelector("details");

    expect(details?.textContent).toContain("literal </details> text");
    expect(details?.textContent).toContain("still inside");
    expect([...fragment.children]).toHaveLength(1);
  });

  it.each([
    ["list item", "- <details>\n  <summary>A</summary>\n\n  still inside"],
    ["blockquote", "> <details>\n> <summary>A</summary>\n>\n> still inside"],
  ])("keeps streaming details intact inside a %s container", (_name, markdown) => {
    const html = toStreamingMarkdownParts(markdown).join("");
    const details = htmlFragment(html).querySelector("details");

    expect(details?.querySelector("summary")?.textContent).toBe("A");
    expect(details?.textContent).toContain("still inside");
    expect(html).not.toContain("&lt;details");
  });

  it("keeps streaming details intact on a wide list continuation indent", () => {
    const html = toStreamingMarkdownParts(
      "1.  item\n    <details>\n    <summary>A</summary>\n\n    still inside",
    ).join("");
    const details = htmlFragment(html).querySelector("details");

    expect(details?.querySelector("summary")?.textContent).toBe("A");
    expect(details?.textContent).toContain("still inside");
    expect(html).not.toContain("&lt;details");
  });
});
