import { describe, expect, it, vi } from "vitest";
import { i18n } from "../i18n/index.ts";
import * as markdownDetails from "./markdown-details.ts";
import { splitStableStreamingMarkdown } from "./markdown-streaming.ts";
import * as markdownText from "./markdown-text.ts";
import { htmlFragment } from "./markdown.test-support.ts";
import { toSanitizedMarkdownHtml, toStreamingMarkdownParts } from "./markdown.ts";

const sanitizedInputLengths = vi.hoisted(() => {
  // Cached markdown sanitizers must be created through this file's factory wrapper.
  vi.resetModules();
  const lengths: number[] = [];
  return lengths;
});

vi.mock(import("dompurify"), async (importOriginal) => {
  const actual = await importOriginal();
  const createDOMPurify = (...factoryArgs: Parameters<typeof actual.default>) => {
    const purifier = actual.default(...factoryArgs);
    const sanitize = purifier.sanitize.bind(purifier);
    vi.spyOn(purifier, "sanitize").mockImplementation((...args) => {
      const [input] = args;
      sanitizedInputLengths.push(typeof input === "string" ? input.length : 0);
      return sanitize(...args);
    });
    return purifier;
  };
  return { ...actual, default: Object.assign(createDOMPurify, actual.default) };
});

describe("toStreamingMarkdownParts", () => {
  it("renders completed paragraphs with linear sanitizer input", () => {
    sanitizedInputLengths.length = 0;
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
      expect(sanitizedInputLengths.length).toBeGreaterThan(0);
      const sanitizedChars = sanitizedInputLengths.reduce((total, length) => total + length, 0);
      expect(sanitizedChars).toBeLessThan(source.length * 2);
    } finally {
      sanitizedInputLengths.length = 0;
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
  const doubled = value < 0 ? 0 : value * 2;
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
    sanitizedInputLengths.length = 0;
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
      expect(sanitizedInputLengths.length).toBeGreaterThan(0);
      const sanitizedChars = sanitizedInputLengths.reduce((total, length) => total + length, 0);
      expect(sanitizedChars).toBeLessThan(prefixes.at(-1)!.length * 20);
    } finally {
      sanitizedInputLengths.length = 0;
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

  it.each(["1. one\n\n   continuation\n"])(
    "keeps the whole container when later blocks retire %j",
    (prefix) => {
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
    },
  );

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

  it("keeps tab-indented list fences incomplete until their closer arrives", () => {
    const fragment = htmlFragment(
      toStreamingMarkdownParts("- item\n\n\t~~~mermaid\n\tgraph TD;\n", {}, "tab-list-fence").join(
        "",
      ),
    );
    expect(fragment.querySelector(".markdown-mermaid")).toBeNull();
    expect(fragment.querySelector("li code")?.textContent).toBe("graph TD;\n");
  });

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
      "## Result\n\nA paragraph with `inline code`.\n\n<details>\n<summary>Logs</summary>\n\n```ts\nconst value = 1;\n```\n\nMore **text**\n\n</details>",
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

  it.each([
    {
      name: "accumulated glyph paragraphs",
      prefix: "▀▀▀▀\n\n",
      source: "▀▀▀▀\n\n▄▄▄▄\n\nIntro",
      code: "▀▀▀▀\n\n▄▄▄▄\n\n",
    },
  ])("renders block art literally: $name", ({ name, source, prefix, code }) => {
    if (prefix !== undefined) {
      toStreamingMarkdownParts(prefix, {}, name);
    }
    const fragment = htmlFragment(
      toStreamingMarkdownParts(source, {}, prefix === undefined ? undefined : name).join(""),
    );
    expect(fragment.querySelector("pre code.markdown-block-art")?.textContent).toBe(code);
    if (prefix === undefined) {
      expect(fragment.querySelector("p")).toBeNull();
    }
  });

  it.each([
    { locale: "en", notice: "… truncated", limit: "showing first 140000" },
    { locale: "pt-BR", notice: "… truncado", limit: "exibindo os primeiros 140000" },
  ] as const)(
    "truncates oversized block art with a $locale notice",
    async ({ locale, notice, limit }) => {
      i18n.registerTranslation("pt-BR", {
        chat: {
          markdown: {
            truncated: "… truncado ({total} caracteres, exibindo os primeiros {shown}).",
          },
        },
      });
      await i18n.setLocale(locale);
      try {
        const blockArt = Array.from({ length: 20_000 }, () => "  ▀▀▀▀  ").join("\n");
        const fragment = htmlFragment(toStreamingMarkdownParts(blockArt).join(""));
        const code = fragment.querySelector("pre code.markdown-block-art");
        expect(code?.textContent).toContain(notice);
        expect(code?.textContent).toContain(limit);
        expect(code?.textContent?.length).toBeLessThan(blockArt.length);
        expect(fragment.textContent).toContain(notice);
        expect(fragment.textContent).toContain(limit);
      } finally {
        await i18n.setLocale("en");
      }
    },
  );
});

describe("indented Markdown source", () => {
  it.each([
    {
      source: "Intro\n\n    a\n\n    b",
      streaming: true,
      text: "a\n\nb\n",
    },
  ])(
    "keeps indented source literal: $source (streaming=$streaming)",
    ({ source, streaming, text }) => {
      const fragment = htmlFragment(
        streaming ? toStreamingMarkdownParts(source).join("") : toSanitizedMarkdownHtml(source),
      );
      expect(fragment.querySelectorAll("pre code")).toHaveLength(1);
      expect(fragment.querySelector("pre code")?.textContent).toBe(text);
    },
  );
});
