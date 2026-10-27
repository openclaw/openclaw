import { beforeAll, describe, expect, it, onTestFinished, vi } from "vitest";
import { i18n } from "../i18n/index.ts";
import { waitForSolid } from "../test-helpers/solid-settle.ts";
import * as markdownDetails from "./markdown-details.ts";
import { splitStableStreamingMarkdown } from "./markdown-streaming.ts";
import * as markdownText from "./markdown-text.ts";
import { htmlFragment, toStreamingMarkdownParts } from "./markdown.test-support.ts";
import { toSanitizedMarkdownHtml } from "./markdown.ts";

const sanitizedInputLengths = vi.hoisted(() => {
  // Cached markdown sanitizers must be created through this file's factory wrapper.
  vi.resetModules();
  const lengths: number[] = [];
  return lengths;
});

const streamHtml = (...args: Parameters<typeof toStreamingMarkdownParts>) =>
  toStreamingMarkdownParts(...args).join("");
const streamFragment = (...args: Parameters<typeof toStreamingMarkdownParts>) =>
  htmlFragment(streamHtml(...args));
const sanitizedChars = (start = 0) =>
  sanitizedInputLengths.slice(start).reduce((total, length) => total + length, 0);

function withSanitizerBudget(run: () => void) {
  sanitizedInputLengths.length = 0;
  try {
    run();
    expect(sanitizedInputLengths.length).toBeGreaterThan(0);
  } finally {
    sanitizedInputLengths.length = 0;
  }
}

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

beforeAll(async () => {
  await waitForSolid(() =>
    expect(toSanitizedMarkdownHtml("```ts\nconst ready = true;\n```")).toContain("hljs-keyword"),
  );
});

describe("toStreamingMarkdownParts", () => {
  it("renders completed paragraphs with linear sanitizer input", () => {
    let source = "";
    withSanitizerBudget(() => {
      for (let index = 0; index < 40; index++) {
        const paragraph = `Stable paragraph ${index} has **formatted** text.\n\n`;
        source += paragraph;
        const previousCalls = sanitizedInputLengths.length;
        const fragment = streamFragment(source, {}, "stable-render-budget");
        expect(fragment.querySelectorAll("p")).toHaveLength(index + 1);
        expect(fragment.querySelectorAll("strong")).toHaveLength(index + 1);
        const deltaChars = sanitizedChars(previousCalls);
        expect(deltaChars).toBeGreaterThan(0);
        expect(deltaChars).toBeLessThan(paragraph.length * 2);
      }
      expect(sanitizedChars()).toBeLessThan(source.length * 2);
    });
  });

  it("caches completed lists, code, and tables in the long streamed reply", () => {
    const sections = Array.from({ length: 28 }, (_, index) =>
      [
        `## Section ${index}: measured browser work`,
        "A clear explanation with **important details** and an inline `value`. The browser should remain responsive as this answer grows. Measure the complete interaction and preserve every message.",
        "- First item with a useful observation\n- Second item with a concrete result\n- Third item with the next action",
        `\`\`\`typescript\nexport function sample${index}(value: number): number {\n  const doubled = value < 0 ? 0 : value * 2;\n  return doubled + ${index};\n}\n\`\`\``,
        "| Metric | Value | Meaning |\n| --- | --- | --- |\n| Frames | 60 | Smooth rendering |\n| Input | 16 | Fast feedback |",
        "",
      ].join("\n\n"),
    );
    const prefixes = sections.map((_, index) => sections.slice(0, index + 1).join(""));
    const expected = prefixes.map((prefix) => toSanitizedMarkdownHtml(prefix));
    let offset = 0;
    withSanitizerBudget(() => {
      for (const [index, prefix] of prefixes.entries()) {
        for (; offset < prefix.length; offset += 24) {
          toStreamingMarkdownParts(prefix.slice(0, offset), {}, "rich-stream-budget");
        }
        expect(streamHtml(prefix, {}, "rich-stream-budget")).toBe(expected[index]);
      }
      expect(sanitizedChars()).toBeLessThan(prefixes.at(-1)!.length * 20);
    });
  });

  it("retires rendered prefixes when display options, locale, or source change", async () => {
    const key = "rendered-prefix-ownership";
    const source = "![Diagram](https://example.com/image.png)\n\n";
    expect(streamFragment(source, {}, key).querySelector("img")).toBeNull();
    expect(
      streamFragment(source, { remoteImages: true }, key).querySelector("img")?.getAttribute("src"),
    ).toBe("https://example.com/image.png");
    i18n.registerTranslation("pt-BR", {
      chat: { externalImage: { notLoaded: "Imagem não carregada", open: "Abrir" } },
    });
    await i18n.setLocale("pt-BR");
    try {
      expect(streamHtml(source, {}, key)).toContain("Imagem não carregada");
      expect(streamHtml("Replacement\n\n", {}, key)).toBe("<p>Replacement</p>\n");
    } finally {
      await i18n.setLocale("en");
    }
  });

  it("relabels earlier file links when later blocks introduce a basename collision", () => {
    const key = "streamed-file-labels";
    const source = "See src/one/index.ts.\n\n";
    toStreamingMarkdownParts(source, { fileLinks: true }, key);
    const fragment = streamFragment(
      `${source}Also src/two/index.ts.\n\n`,
      { fileLinks: true },
      key,
    );
    expect(
      [...fragment.querySelectorAll(".markdown-file-link")].map((link) => link.textContent),
    ).toEqual(["one/index.ts", "two/index.ts"]);
  });

  it("keeps tab-indented list fences incomplete until their closer arrives", () => {
    const fragment = streamFragment("- item\n\n\t~~~mermaid\n\tgraph TD;\n", {}, "tab-list-fence");
    expect(fragment.querySelector(".markdown-mermaid")).toBeNull();
    expect(fragment.querySelector("li code")?.textContent).toBe("graph TD;\n");
  });

  it("revisits reference links when a completed disclosure defines their target", () => {
    const key = "disclosure-reference";
    const source = "See [x]\n\n";
    toStreamingMarkdownParts(source, {}, key);
    const fragment = streamFragment(
      `${source}<details>\n<summary>More</summary>\n\n[x]: https://example.com\n\n</details>\n\n`,
      {},
      key,
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
      expect(streamHtml(source, { progressBars: true }, key)).toBe(
        "<ul>\n<li>\n<p>one</p>\n</li>\n<li>\n<p>two</p>\n</li>\n</ul>\n",
      );
    }
  });

  it.each(["completed disclosure", "literal container"])(
    "does not rescan a %s on append",
    (kind) => {
      let prefix = "<details><summary>Done</summary></details>\n\n";
      const disclosure = kind === "completed disclosure";
      const prefixes = Array.from({ length: 48 }, (_, index) => {
        prefix += `${String(index).padStart(3, "0")} ${"streaming markdown ".repeat(30)}\n`;
        return disclosure ? prefix : `<details>\n> <!--\n> ${"literal ".repeat((index + 1) * 30)}`;
      });
      const scanner = vi.spyOn(
        markdownDetails,
        disclosure ? "scanMarkdownDisclosureLine" : "findMarkdownRawHtmlRanges",
      );
      onTestFinished(() => scanner.mockRestore());
      const render = (value: string, key?: string) =>
        disclosure ? splitStableStreamingMarkdown(value, key) : streamHtml(value, {}, key);
      const full = prefixes.map((value) => render(value));
      expect(scanner).toHaveBeenCalledTimes(prefixes.length);
      scanner.mockClear();
      expect(prefixes.map((value) => render(value, `${kind}-scan-regression`))).toEqual(full);
      expect(scanner).toHaveBeenCalledTimes(1);
    },
  );

  it("keeps chunked-prefix splits identical to full splits", () => {
    const completedContainers = [
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
    ].map((suffix) => `1. one\n\n   continuation\n${suffix}`);
    const cases = [
      ...completedContainers,
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
          expect(streamHtml(prefix, {}, `html-parity-${key}`)).toBe(streamHtml(prefix));
          if (end >= markdown.length) {
            if (caseIndex < completedContainers.length) {
              expect(streamHtml(prefix, {}, `html-parity-${key}`)).toBe(
                toSanitizedMarkdownHtml(markdown),
              );
            }
            break;
          }
        }
      }
    }
  });

  it("keeps streaming indented source literal", () => {
    const fragment = streamFragment("Intro\n\n    a\n\n    b");
    expect(fragment.querySelectorAll("pre code")).toHaveLength(1);
    expect(fragment.querySelector("pre code")?.textContent).toBe("a\n\nb\n");
  });

  it("normalizes an appended CRLF boundary without rescanning the prefix", () => {
    const key = "incremental-line-ending-normalization";
    const expected = streamHtml("before\r\nafter");
    const normalize = vi.spyOn(markdownText, "normalizeMarkdownLineBreaks");
    onTestFinished(() => normalize.mockRestore());
    toStreamingMarkdownParts("before\r", {}, key);
    normalize.mockClear();

    expect(streamHtml("before\r\nafter", {}, key)).toBe(expected);
    expect(normalize).toHaveBeenCalledWith("\nafter");
    expect(normalize).not.toHaveBeenCalledWith("before\r\nafter");
  });

  it("preserves incremental parity when streamed text grows beyond the truncation cap", () => {
    const text = Array.from(
      { length: 210 },
      (_, index) => `${String(index).padStart(3, "0")} ${"streamed markdown ".repeat(55)}\n`,
    ).join("");

    for (const end of [139_500, 140_050, 141_000, text.length]) {
      const prefix = text.slice(0, end);

      expect(streamHtml(prefix, {}, "truncated-stream-parity")).toBe(streamHtml(prefix));
    }
  });

  it("marks a completed transcript-role header in the streaming tail", () => {
    const html = streamHtml("user[Thu 2026-07-02] question", {
      assistantTranscriptRoleHeaders: true,
    });

    expect(html).toContain('class="assistant-transcript-role"');
  });

  it.each([
    ["en", "… truncated", "showing first 140000"],
    ["pt-BR", "… truncado", "exibindo os primeiros 140000"],
  ] as const)("localizes oversized block-art truncation: %s", async (locale, notice, limit) => {
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
      const fragment = streamFragment(blockArt);
      const code = fragment.querySelector("pre code.markdown-block-art");
      expect(code?.textContent).toContain(notice);
      expect(code?.textContent).toContain(limit);
      expect(code?.textContent?.length).toBeLessThan(blockArt.length);
      expect(fragment.textContent).toContain(notice);
      expect(fragment.textContent).toContain(limit);
    } finally {
      await i18n.setLocale("en");
    }
  });
});
