import DOMPurify from "dompurify";
import { describe, expect, it, vi } from "vitest";
import { i18n } from "../i18n/index.ts";
import * as markdownDetails from "./markdown-details.ts";
import { splitStableStreamingMarkdown } from "./markdown-streaming.ts";
import * as markdownText from "./markdown-text.ts";
import { htmlFragment } from "./markdown.test-support.ts";
import { toSanitizedMarkdownHtml, toStreamingMarkdownParts } from "./markdown.ts";

describe("toStreamingMarkdownParts", () => {
  it("renders completed paragraphs with linear sanitizer input", () => {
    const sanitize = vi.spyOn(DOMPurify, "sanitize");
    let source = "";
    try {
      for (let index = 0; index < 40; index++) {
        source += `Stable paragraph ${index} has **formatted** text.\n\n`;
        const fragment = htmlFragment(
          toStreamingMarkdownParts(source, {}, "stable-render-budget").join(""),
        );
        expect(fragment.querySelectorAll("p")).toHaveLength(index + 1);
        expect(fragment.querySelectorAll("strong")).toHaveLength(index + 1);
      }
      const sanitizedChars = sanitize.mock.calls.reduce(
        (total, [input]) => total + (typeof input === "string" ? input.length : 0),
        0,
      );
      expect(sanitizedChars).toBeLessThan(source.length * 2);
    } finally {
      sanitize.mockRestore();
    }
  });

  it("caches completed lists, code, and tables in the long streamed reply", () => {
    const sections = Array.from(
      { length: 28 },
      (_, index) => `## Section ${index}: measured browser work

A clear explanation with **important details** and an inline \`value\`. The browser should remain responsive as this answer grows. Measure the complete interaction and preserve every message.

- First item with a useful observation
- Second item with a concrete result
- Third item with the next action

\`\`\`typescript
export function sample${index}(value: number): number {
  const doubled = value * 2;
  return doubled + ${index};
}
\`\`\`

| Metric | Value | Meaning |
| --- | --- | --- |
| Frames | 60 | Smooth rendering |
| Input | 16 | Fast feedback |

`,
    );
    const prefixes = sections.map((_, index) => sections.slice(0, index + 1).join(""));
    const expected = prefixes.map((prefix) => toSanitizedMarkdownHtml(prefix));
    const sanitize = vi.spyOn(DOMPurify, "sanitize");
    let offset = 0;
    try {
      for (const [index, prefix] of prefixes.entries()) {
        for (; offset < prefix.length; offset += 24) {
          toStreamingMarkdownParts(prefix.slice(0, offset), {}, "rich-stream-budget");
        }
        expect(toStreamingMarkdownParts(prefix, {}, "rich-stream-budget").join("")).toBe(
          expected[index],
        );
      }
      const sanitizedChars = sanitize.mock.calls.reduce(
        (total, [input]) => total + (typeof input === "string" ? input.length : 0),
        0,
      );
      expect(sanitizedChars).toBeLessThan(prefixes.at(-1)!.length * 20);
    } finally {
      sanitize.mockRestore();
    }
  });

  it("retires rendered prefixes when display options, locale, or source change", async () => {
    const key = "rendered-prefix-ownership";
    const source = "![Diagram](https://example.com/image.png)\n\n";
    expect(
      htmlFragment(toStreamingMarkdownParts(source, {}, key).join("")).querySelector("img"),
    ).toBeNull();
    expect(
      htmlFragment(toStreamingMarkdownParts(source, { remoteImages: true }, key).join(""))
        .querySelector("img")
        ?.getAttribute("src"),
    ).toBe("https://example.com/image.png");
    i18n.registerTranslation("pt-BR", {
      chat: { externalImage: { notLoaded: "Imagem não carregada", open: "Abrir" } },
    });
    await i18n.setLocale("pt-BR");
    try {
      expect(toStreamingMarkdownParts(source, {}, key).join("")).toContain("Imagem não carregada");
      expect(toStreamingMarkdownParts("Replacement\n\n", {}, key).join("")).toBe(
        "<p>Replacement</p>\n",
      );
    } finally {
      await i18n.setLocale("en");
    }
  });

  it.each([
    "- one\n\n",
    "- one\n\n  continuation\n",
    "1. one\n\n   continuation\n",
    "- one\n\n  - nested\n\n    continuation\n",
    "Intro\n2. paragraph\n\n",
  ])("keeps the whole container when later blocks retire %j", (prefix) => {
    for (const suffix of [
      "# Heading\n",
      "---\n",
      "> quote\n",
      "> ~~~\n> code\n> ~~~\n> after\n",
      "> ~~~\n> code\n> ~~~\n> after\n\nFollowing\n",
      "```\ncode\n```\n",
      "<details><summary>More</summary>body</details>\n",
      "+ next\n",
      "2. next\n",
      "\nParagraph\n",
      "▀▀▀▀\n▄▄▄▄\n",
    ]) {
      const source = prefix + suffix;
      const expected = toSanitizedMarkdownHtml(source);
      for (const chunkSize of [1, 7, 24]) {
        const key = `retired-container-${source}-${chunkSize}`;
        for (let end = chunkSize; end < source.length; end += chunkSize) {
          toStreamingMarkdownParts(source.slice(0, end), {}, key);
        }
        expect(toStreamingMarkdownParts(source, {}, key).join(""), key).toBe(expected);
      }
    }
  });

  it("relabels earlier file links when later blocks introduce a basename collision", () => {
    const key = "streamed-file-labels";
    const source = "See src/one/index.ts.\n\n";
    toStreamingMarkdownParts(source, { fileLinks: true }, key);
    const fragment = htmlFragment(
      toStreamingMarkdownParts(
        `${source}Also src/two/index.ts.\n\n`,
        { fileLinks: true },
        key,
      ).join(""),
    );
    expect(
      [...fragment.querySelectorAll(".markdown-file-link")].map((link) => link.textContent),
    ).toEqual(["one/index.ts", "two/index.ts"]);
  });

  it("keeps block-art-looking paragraphs in their surrounding prose", () => {
    const key = "prose-with-block-glyphs";
    const intro = "Intro\n\n";
    toStreamingMarkdownParts(intro, {}, key);
    expect(toStreamingMarkdownParts(`${intro}▀▀▀▀\n▄▄▄▄\n\n`, {}, key).join("")).toBe(
      "<p>Intro</p>\n<p>▀▀▀▀<br>\n▄▄▄▄</p>\n",
    );
  });

  it("reclassifies a completed block-art prefix when prose becomes stable", () => {
    const key = "block-art-before-prose";
    const source = "▀▀▀▀\n▄▄▄▄\n\nIntro";
    toStreamingMarkdownParts(source, {}, key);
    expect(toStreamingMarkdownParts(`${source}\n\n`, {}, key).join("")).toBe(
      "<p>▀▀▀▀<br>\n▄▄▄▄</p>\n<p>Intro</p>\n",
    );
  });

  it("classifies accumulated glyph paragraphs as one block-art prefix", () => {
    const key = "accumulated-block-art";
    const source = "▀▀▀▀\n\n";
    toStreamingMarkdownParts(source, {}, key);
    const fragment = htmlFragment(
      toStreamingMarkdownParts(`${source}▄▄▄▄\n\nIntro`, {}, key).join(""),
    );
    expect(fragment.querySelector("code.markdown-block-art")?.textContent).toBe("▀▀▀▀\n\n▄▄▄▄\n\n");
  });

  it("keeps list-looking fence markers inside a root code block", () => {
    const key = "literal-list-fence";
    const source = "~~~\ncode\n- ~~~\n";
    toStreamingMarkdownParts(source, {}, key);
    const fragment = htmlFragment(toStreamingMarkdownParts(`${source}more\n\n`, {}, key).join(""));
    expect(fragment.querySelector("pre code")?.textContent).toBe("code\n- ~~~\nmore\n\n");
  });

  it("keeps tab-indented list fences incomplete until their closer arrives", () => {
    const fragment = htmlFragment(
      toStreamingMarkdownParts("- item\n\n\t~~~mermaid\n\tgraph TD;\n", {}, "tab-list-fence").join(
        "",
      ),
    );
    expect(fragment.querySelector(".markdown-mermaid")).toBeNull();
    expect(fragment.querySelector("li code")?.textContent).toBe("graph TD;\n");
  });

  it("keeps a completed fence and its continuation in one blockquote", () => {
    const key = "quoted-fence-continuation";
    const source = "> ~~~\n> code\n> ~~~\n";
    toStreamingMarkdownParts(source, {}, key);
    const fragment = htmlFragment(
      toStreamingMarkdownParts(`${source}> after\n\n`, {}, key).join(""),
    );
    expect(fragment.querySelectorAll("blockquote")).toHaveLength(1);
    expect(fragment.querySelector("blockquote code")?.textContent).toBe("code\n");
    expect(fragment.querySelector("blockquote p")?.textContent).toBe("after");
  });

  it.each(["-", "+", "*", "1.", "1)"])(
    "keeps standalone %s list markers with their paragraph continuations",
    (marker) => {
      const key = `standalone-list-${marker}`;
      const indent = " ".repeat(marker.length + 1);
      const source = `${marker}\n${indent}first\n\n`;
      toStreamingMarkdownParts(source, {}, key);
      const fragment = htmlFragment(
        toStreamingMarkdownParts(`${source}${indent}second\n\n`, {}, key).join(""),
      );
      expect(fragment.querySelectorAll("li")).toHaveLength(1);
      expect(
        [...fragment.querySelectorAll("li p")].map((paragraph) => paragraph.textContent),
      ).toEqual(["first", "second"]);
    },
  );

  it("keeps a standalone hyphen as a setext heading underline after prose", () => {
    const key = "setext-hyphen";
    toStreamingMarkdownParts("Title\n", {}, key);
    expect(toStreamingMarkdownParts("Title\n-\n\n", {}, key).join("")).toBe("<h2>Title</h2>\n");
  });

  it("keeps nonbreaking-space lines inside their streaming paragraph", () => {
    const key = "nonbreaking-space-paragraph";
    const source = "First\n\u00a0\n";
    toStreamingMarkdownParts(source, {}, key);
    const fragment = htmlFragment(
      toStreamingMarkdownParts(`${source}Second\n\n`, {}, key).join(""),
    );
    expect(fragment.querySelectorAll("p")).toHaveLength(1);
    expect(fragment.querySelector("p")?.textContent).toBe("First\n\u00a0\nSecond");
  });

  it.each([
    {
      name: "an unfinished blank line",
      source: "Hello\n ",
      suffix: "world\n\n",
      paragraph: "Hello\nworld",
    },
    {
      name: "an unfinished fence closer",
      source: "~~~\ncode\n~~~",
      suffix: "~\nafter\n\n",
      paragraph: "after",
    },
  ])(
    "revisits $name before extending its rendered prefix",
    ({ name, source, suffix, paragraph }) => {
      toStreamingMarkdownParts(source, {}, name);
      const fragment = htmlFragment(toStreamingMarkdownParts(source + suffix, {}, name).join(""));
      expect(fragment.querySelectorAll("p")).toHaveLength(1);
      expect(fragment.querySelector("p")?.textContent).toBe(paragraph);
    },
  );

  it("revisits reference links when a completed disclosure defines their target", () => {
    const key = "disclosure-reference";
    const source = "See [x]\n\n";
    toStreamingMarkdownParts(source, {}, key);
    const fragment = htmlFragment(
      toStreamingMarkdownParts(
        `${source}<details>\n<summary>More</summary>\n\n[x]: https://example.com\n\n</details>\n\n`,
        {},
        key,
      ).join(""),
    );
    expect(fragment.querySelector("p a")?.getAttribute("href")).toBe("https://example.com");
  });

  it("removes completed raw-content blocks across earlier streaming boundaries", () => {
    const key = "progress-raw-content";
    const source = "before <script>hidden\n\n";
    toStreamingMarkdownParts(source, { progressBars: true }, key);
    expect(
      toStreamingMarkdownParts(`${source}more</script>\n\n`, { progressBars: true }, key).join(""),
    ).toBe("<p>before</p>\n");
  });

  it("keeps lists joined when progress rendering removes their HTML separator", () => {
    const source = "- one\n\n<script>hidden</script>\n\n- two\n";
    for (const chunkSize of [1, 7, 24]) {
      const key = `progress-list-separator-${chunkSize}`;
      for (let end = chunkSize; end < source.length; end += chunkSize) {
        toStreamingMarkdownParts(source.slice(0, end), { progressBars: true }, key);
      }
      expect(toStreamingMarkdownParts(source, { progressBars: true }, key).join("")).toBe(
        "<ul>\n<li>\n<p>one</p>\n</li>\n<li>\n<p>two</p>\n</li>\n</ul>\n",
      );
    }
  });

  it("keeps reference resolution consistent while an independent tail grows", () => {
    const key = "reference-tail-environment";
    const source =
      "<details>\n<summary>More</summary>\n\n[x]: https://example.com\n\n</details>\n\nSee [x]";
    for (const suffix of ["", " again"]) {
      expect(toStreamingMarkdownParts(source + suffix, {}, key)[1]).toBe(
        `<p>See [x]${suffix}</p>\n`,
      );
    }
  });

  it.each([
    { name: "backtick fence info", source: "```foo`bar\ninside\n```\n", code: "after\n\n" },
    {
      name: "nonbreaking-space fence suffix",
      source: "```\ncode\n```\u00a0\n",
      code: "code\n```\u00a0\nafter\n\n",
    },
  ])("keeps $name from closing the actual open fence", ({ name, source, code }) => {
    toStreamingMarkdownParts(source, {}, name);
    const fragment = htmlFragment(
      toStreamingMarkdownParts(`${source}after\n\n`, {}, name).join(""),
    );
    expect(fragment.querySelector("pre code")?.textContent).toBe(code);
  });

  it("does not rescan completed disclosures in appended prefixes", () => {
    const prefixes: string[] = [];
    let prefix = "<details><summary>Done</summary></details>\n\n";
    for (let index = 0; index < 48; index += 1) {
      prefix += `${String(index).padStart(3, "0")} ${"streaming markdown ".repeat(30)}\n`;
      prefixes.push(prefix);
    }
    // A full rescan revisits the completed disclosure on every chunk. Observe
    // the real scanner instead of comparing sub-millisecond wall-clock times.
    const scanDisclosure = vi.spyOn(markdownDetails, "scanMarkdownDisclosureLine");
    try {
      const fullSplits = prefixes.map((value) => splitStableStreamingMarkdown(value));
      expect(scanDisclosure).toHaveBeenCalledTimes(prefixes.length);
      scanDisclosure.mockClear();

      const incrementalSplits = prefixes.map((value) =>
        splitStableStreamingMarkdown(value, "line-scan-regression"),
      );
      expect(incrementalSplits).toEqual(fullSplits);
      expect(scanDisclosure).toHaveBeenCalledTimes(1);
    } finally {
      scanDisclosure.mockRestore();
    }
  });

  it("does not reparse a literal container line on each append", () => {
    const prefixes = Array.from(
      { length: 48 },
      (_, index) => `<details>\n> <!--\n> ${"literal ".repeat((index + 1) * 30)}`,
    );
    const findRawRanges = vi.spyOn(markdownDetails, "findMarkdownRawHtmlRanges");
    try {
      const fullHtml = prefixes.map((value) => toStreamingMarkdownParts(value).join(""));
      expect(findRawRanges).toHaveBeenCalledTimes(prefixes.length);
      findRawRanges.mockClear();

      const incrementalHtml = prefixes.map((value) =>
        toStreamingMarkdownParts(value, {}, "literal-line-scan-regression").join(""),
      );
      expect(incrementalHtml).toEqual(fullHtml);
      expect(findRawRanges).toHaveBeenCalledTimes(1);
    } finally {
      findRawRanges.mockRestore();
    }
  });

  it("keeps chunked-prefix splits identical to full splits", () => {
    const cases = [
      [
        "## Result",
        "",
        "A paragraph with `inline code`.",
        "",
        "<details>",
        "<summary>Logs</summary>",
        "",
        "```ts",
        "const value = 1;",
        "```",
        "",
        "More **text**",
        "",
        "</details>",
      ].join("\n"),
      "- first\n\n  continuation\n\n# Done\n\n- next\n\n+ changed marker\n\nAfter\n\n",
      "1. one\n\n    - nested\n\n        code\n\n# Done\n\nAfter\n\n",
      "- before\n\n~~~\n- ~~~\n*literal\n~~~\n\nAfter\n\n",
      "- [x] Safe\n\nDone\n\n- [evil](javascript:alert(1))\n\n<script>alert(1)</script>\n\nAfter\n\n",
      "- one\n\n  - nested\n\n[Docs][ref\\]]\n\n[ref\\]]: /docs",
      "`` multiline\n<details> remains code\n``\n\n<details>\n<summary>Real</summary>",
      "- item\n\n    <details>\n    <summary>Logs</summary>\n\n    still inside",
      "Intro\n\n    code\n\n    continuation\n\nAfter\n\n",
      "> First quote\n\n> Second quote\n\nAfter\n\n",
      "1. item\n\n    <details>\n    <summary>Logs</summary>\n\n    still inside",
      ...[
        "> <!--\n> **literal",
        "- item\n\n  <pre>\n  **literal\n\n  **still literal",
        "> - item\n>\n>   <!--\n>   **literal",
        "10. item\n\n    <pre>\n    **literal",
        "-\t<pre>\n\t**literal",
      ].map(
        (raw) =>
          `<details>\n<summary>X</summary>\n\n${raw}\n\n</details>\n\n**outside\n\n<details>\n<summary>Next`,
      ),
      "<details>\r\n> <!--\r\n> **literal\r\n\r\n</details>\r\n\r\n**outside",
      ...["<!--\n</details>\n-->", "<pre>\n</details>\n</pre>", "<!doctype\n</details>\n>"].flatMap(
        (raw) =>
          [
            `<details>\n<summary>X</summary>\n\n<div>\n${raw}\n</div>\n\nStill inside\n</details>\n\nFollowing`,
            `${raw.replace("</details>", "<details>")}\n\n<details><summary>Next</summary>body`,
          ].concat(
            ["**", "`"].map(
              (delimiter) =>
                `<details>\n<summary>X</summary>\n\n${raw.replace("</details>", `${delimiter}literal`)}\n${delimiter}outside`,
            ),
          ),
      ),
    ];
    for (const [caseIndex, markdown] of cases.entries()) {
      for (const chunkSize of [1, 7, 64]) {
        for (let end = chunkSize; end <= markdown.length + chunkSize; end += chunkSize) {
          const prefix = markdown.slice(0, Math.min(end, markdown.length));
          const key = `${caseIndex}-${chunkSize}`;
          expect(splitStableStreamingMarkdown(prefix, `split-parity-${key}`)).toEqual(
            splitStableStreamingMarkdown(prefix),
          );
          expect(toStreamingMarkdownParts(prefix, {}, `html-parity-${key}`).join("")).toBe(
            toStreamingMarkdownParts(prefix).join(""),
          );
          if (end >= markdown.length) {
            break;
          }
        }
      }
    }
  });

  it("resets replaced streams and keeps interleaved streams independent", () => {
    const streams = new Map([
      ["a", "First stream\n\n```ts\nconst a = 1;"],
      ["b", "Second stream\n\n<details>\n<summary>B</summary>"],
      ["raw", "<details>\n> <pre>\n> literal"],
    ]);
    for (const end of [8, 16, 32, 64]) {
      for (const [key, markdown] of streams) {
        const prefix = markdown.slice(0, end);
        expect(splitStableStreamingMarkdown(prefix, `interleaved-${key}`)).toEqual(
          splitStableStreamingMarkdown(prefix),
        );
      }
    }
    for (const replacement of [
      "short",
      "Replacement\n\n- starts a different list",
      "A much longer replacement\n\n```ts\nconst changed = true;",
    ]) {
      for (const key of ["a", "raw"]) {
        expect(splitStableStreamingMarkdown(replacement, `interleaved-${key}`)).toEqual(
          splitStableStreamingMarkdown(replacement),
        );
      }
    }
  });

  it("resets an incremental cursor when a completed citation marker rewrites its prefix", () => {
    const partial = "Intro\n\ncitevery-long-partial-citation-marker";
    const completed = `${partial}\n\n\`\`\`ts\nconst answer = 42;`;

    toStreamingMarkdownParts(partial, {}, "citation-prefix-replacement");

    expect(toStreamingMarkdownParts(completed, {}, "citation-prefix-replacement").join("")).toBe(
      toStreamingMarkdownParts(completed).join(""),
    );
  });

  it("normalizes an appended CRLF boundary without rescanning the prefix", () => {
    const key = "incremental-line-ending-normalization";
    const expected = toStreamingMarkdownParts("before\r\nafter").join("");
    const normalize = vi.spyOn(markdownText, "normalizeMarkdownLineBreaks");
    try {
      toStreamingMarkdownParts("before\r", {}, key);
      normalize.mockClear();

      expect(toStreamingMarkdownParts("before\r\nafter", {}, key).join("")).toBe(expected);
      expect(normalize).toHaveBeenCalledWith("\nafter");
      expect(normalize).not.toHaveBeenCalledWith("before\r\nafter");
    } finally {
      normalize.mockRestore();
    }
  });

  it.each(["- item", "1. item"])(
    "keeps details inside a loose %s list continuation while streaming",
    (item) => {
      const markdown = `${item}\n\n    <details>\n    <summary>Logs</summary>\n\n    still inside`;
      const fragment = htmlFragment(
        toStreamingMarkdownParts(markdown, {}, `loose-list:${item}`).join(""),
      );
      const details = fragment.querySelector("li details");

      expect(details?.querySelector("summary")?.textContent).toBe("Logs");
      expect(details?.textContent).toContain("still inside");
    },
  );

  it("preserves incremental parity when streamed text grows beyond the truncation cap", () => {
    const text = Array.from(
      { length: 210 },
      (_, index) => `${String(index).padStart(3, "0")} ${"streamed markdown ".repeat(55)}\n`,
    ).join("");

    for (const end of [139_500, 140_050, 141_000, text.length]) {
      const prefix = text.slice(0, end);

      expect(toStreamingMarkdownParts(prefix, {}, "truncated-stream-parity").join("")).toBe(
        toStreamingMarkdownParts(prefix).join(""),
      );
    }
  });

  it("marks a completed transcript-role header in the streaming tail", () => {
    const html = toStreamingMarkdownParts("user[Thu 2026-07-02] question", {
      assistantTranscriptRoleHeaders: true,
    }).join("");

    expect(html).toContain('class="assistant-transcript-role"');
  });

  it("renders streaming raw block art without collapsing quiet-zone spaces", () => {
    const blockArt = "  ▀▀▀▀  \n  ▄▄▄▄  \n  ████  ";
    const html = toStreamingMarkdownParts(blockArt).join("");
    const fragment = htmlFragment(html);
    const code = fragment.querySelector("pre code.markdown-block-art");

    expect(fragment.querySelector("p")).toBeNull();
    expect(code?.textContent).toBe(blockArt);
  });

  it("truncates oversized streaming raw block art before rendering", () => {
    const line = "  ▀▀▀▀  ";
    const blockArt = Array.from({ length: 20_000 }, () => line).join("\n");
    const html = toStreamingMarkdownParts(blockArt).join("");
    const fragment = htmlFragment(html);
    const code = fragment.querySelector("pre code.markdown-block-art");

    expect(code?.textContent).toContain("… truncated");
    expect(code?.textContent).toContain(`showing first 140000`);
    expect(code?.textContent?.length).toBeLessThan(blockArt.length);
  });

  it("localizes the oversized markdown truncation notice", async () => {
    i18n.registerTranslation("pt-BR", {
      chat: {
        markdown: {
          truncated: "… truncado ({total} caracteres, exibindo os primeiros {shown}).",
        },
      },
    });
    await i18n.setLocale("pt-BR");
    try {
      const blockArt = Array.from({ length: 20_000 }, () => "  ▀▀▀▀  ").join("\n");
      const fragment = htmlFragment(toStreamingMarkdownParts(blockArt).join(""));
      expect(fragment.textContent).toContain("… truncado");
      expect(fragment.textContent).toContain("exibindo os primeiros 140000");
    } finally {
      await i18n.setLocale("en");
    }
  });

  it.each([
    ["loose sibling list items", "- one\n\n- two"],
    ["list-item paragraph continuation", "- one\n\n  continuation"],
    ["nested loose list items", "- one\n\n  - nested"],
    ["a reference link and its later definition", "[Docs][doc]\n\n[doc]: https://example.com"],
    ["escaped bracket labels", "[Docs][ref\\]]\n\n[ref\\]]: https://example.com"],
    ["multiline reference labels", "[Docs][foo bar]\n\n[foo\n bar]: https://example.com"],
    ["list-nested reference definitions", "See [x]\n\n- item\n\n    [x]: /url"],
    ["tab-indented list continuation", "Intro\n\n  - one\n\n\tcontinuation"],
    ["list continuation before a root heading", "- one\n\n  continuation\n# Heading"],
  ])("preserves whole-document Markdown semantics for %s", (_kind, input) => {
    expect(toStreamingMarkdownParts(input).join("")).toBe(toSanitizedMarkdownHtml(input));
  });

  it("uses Unicode separators as stable markdown boundaries", () => {
    const html = toStreamingMarkdownParts("## Done\u2028\u2028working **tail").join("");

    expect(html).toBe("<h2>Done</h2>\n<p>working <strong>tail</strong></p>\n");
  });

  it("renders a single open paragraph as markdown with closed formatting", () => {
    const html = toStreamingMarkdownParts("**still streaming").join("");

    expect(html).toBe("<p><strong>still streaming</strong></p>\n");
  });

  it("renders half-written links as text only while streaming", () => {
    const html = toStreamingMarkdownParts("see [Streamdown](https://strea").join("");

    expect(html).toBe("<p>see Streamdown</p>\n");
  });

  it("streams tables as markdown before the closing row arrives", () => {
    const html = toStreamingMarkdownParts("| left | right |\n| --- | --- |\n| 1 | 2").join("");
    const fragment = htmlFragment(html);

    expect(fragment.querySelector("table")).not.toBeNull();
    expect(fragment.querySelector("th")?.textContent).toBe("left");
    expect(html).not.toContain("markdown-plain-text-fallback");
  });

  it("leaves dollar amounts alone while streaming", () => {
    const html = toStreamingMarkdownParts("prices are $$50 and").join("");

    expect(html).toBe("<p>prices are $$50 and</p>\n");
  });
});

describe("indented Markdown source", () => {
  it.each(["    ", "\t", " \t", "  \t", "   \t"])(
    "retains indented code across completed streaming prefixes: %j",
    (indent) => {
      const key = `completed-indentation-${indent}`;
      const source = `Intro\n\n${indent}code\n\n`;
      toStreamingMarkdownParts(source, {}, key);
      const fragment = htmlFragment(
        toStreamingMarkdownParts(`${source}${indent}continuation\n\nAfter\n\n`, {}, key).join(""),
      );
      expect(fragment.querySelectorAll("pre code")).toHaveLength(1);
      expect(fragment.querySelector("pre code")?.textContent).toBe("code\n\ncontinuation\n");
    },
  );

  it.each(["    *literal*", "\t*literal*", "\n\n    *literal*"])(
    "renders initial code: %j",
    (source) => {
      expect(
        htmlFragment(toSanitizedMarkdownHtml(source)).querySelector("pre code")?.textContent,
      ).toBe("*literal*\n");
    },
  );

  it.each(["    a\n\n    b", "Intro\n\n    a\n\n    b"])(
    "keeps a streamed indented block together: %j",
    (source) => {
      const fragment = htmlFragment(toStreamingMarkdownParts(source).join(""));
      expect(fragment.querySelectorAll("pre code")).toHaveLength(1);
      expect(fragment.querySelector("pre code")?.textContent).toBe("a\n\nb\n");
    },
  );

  it("never repairs literal punctuation inside streaming indented code", () => {
    const source = "    *literal";
    for (let end = 5; end <= source.length; end++) {
      const fragment = htmlFragment(
        toStreamingMarkdownParts(source.slice(0, end), {}, "indented-prefix").join(""),
      );
      expect(fragment.querySelector("pre code")?.textContent).toBe(`${source.slice(4, end)}\n`);
    }
  });
});
