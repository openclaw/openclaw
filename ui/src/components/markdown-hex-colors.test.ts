import { describe, expect, it } from "vitest";
import { htmlFragment } from "./markdown.test-support.ts";
import { toSanitizedMarkdownHtml, toStreamingMarkdownParts } from "./markdown.ts";

function swatches(fragment: HTMLElement) {
  return [...fragment.querySelectorAll<HTMLImageElement>(".markdown-hex-color__swatch")];
}

describe("Markdown hex colors", () => {
  it("previews all CSS hex lengths without changing readable or copied text", () => {
    const source = "Palette: #abc, #AbC8, #178969, #AAbbCC80; #000 and #fff.";
    const fragment = htmlFragment(toSanitizedMarkdownHtml(source));
    expect(fragment.textContent?.trim()).toBe(source);
    expect(swatches(fragment).map((image) => image.parentElement?.textContent)).toEqual([
      "#abc",
      "#AbC8",
      "#178969",
      "#AAbbCC80",
      "#000",
      "#fff",
    ]);
    for (const image of swatches(fragment)) {
      expect(image.alt).toBe("");
      expect(image.getAttribute("aria-hidden")).toBe("true");
      const svg = decodeURIComponent(image.getAttribute("src")!.split(",")[1]!);
      expect(svg).toContain(`fill="${image.parentElement?.textContent}"`);
    }
    expect(fragment.querySelector("[style], button, a")).toBeNull();
  });

  it("leaves invalid tokens, literal code, links, images, and HTML untouched", () => {
    const source = [
      "#ab #abcde #abcdefg #abcdefghi #123456789 #12g #abcxyz ##abc x#abc #abc_def #abc.txt #abc/path",
      "`#abc` [#def](https://example.com/#abc) https://example.com/#abc <https://example.com/#abc>",
      '![#abc](https://example.com/image.png) <span title="#abc">raw</span>',
      "```css\n#abc { color: #fff; }\n```",
      "    #abc",
    ].join("\n\n");
    const fragment = htmlFragment(toSanitizedMarkdownHtml(source));
    expect(swatches(fragment)).toHaveLength(0);
    expect(fragment.querySelector("code")?.textContent).toBe("#abc");
    expect(fragment.querySelector("a")?.getAttribute("href")).toBe("https://example.com/#abc");
  });

  it("keeps repository references as links and reader documents literal", () => {
    const fragment = htmlFragment(
      toSanitizedMarkdownHtml("PR openclaw/openclaw#178969, color #aabbcc.", {}),
    );
    expect(fragment.querySelector("a")?.getAttribute("href")).toBe(
      "https://github.com/openclaw/openclaw/pull/178969",
    );
    expect(swatches(fragment).map((image) => image.parentElement?.textContent)).toEqual([
      "#aabbcc",
    ]);
    expect(
      swatches(htmlFragment(toSanitizedMarkdownHtml("#abc", { mode: "document" }))),
    ).toHaveLength(0);
  });

  it("keeps unresolved item references plain while preserving numeric colors", () => {
    const source = "PR #126; issue **#1234**; pull request #123456; fixes #12345678; color #126.";
    for (const fragment of [
      htmlFragment(toSanitizedMarkdownHtml(source)),
      htmlFragment(toStreamingMarkdownParts(source).join("")),
    ]) {
      expect(fragment.querySelector("a")).toBeNull();
      expect(swatches(fragment).map((image) => image.parentElement?.textContent)).toEqual(["#126"]);
      expect(fragment.textContent?.trim()).toBe(source.replaceAll("**", ""));
    }
  });

  it("replaces partial streaming colors without retaining invalid prefixes", () => {
    const streamKey = "hex-colors-stream";
    for (const [tail, expected] of [
      ["#ab", []],
      ["#abc", ["#abc"]],
      ["#abcd", ["#abcd"]],
      ["#abcde", []],
      ["#abcdef", ["#abcdef"]],
      ["#abcdefg", []],
    ] as const) {
      const source = `Stable #fff.\n\nColor ${tail}`;
      const fragment = htmlFragment(toStreamingMarkdownParts(source, {}, streamKey).join(""));
      expect(swatches(fragment).map((image) => image.parentElement?.textContent)).toEqual([
        "#fff",
        ...expected,
      ]);
      expect(fragment.textContent?.trim()).toBe(`Stable #fff.\nColor ${tail}`);
    }
  });
});
