import { describe, expect, it } from "vitest";
import { htmlFragment, toStreamingMarkdownParts } from "./markdown.test-support.ts";
import { toSanitizedMarkdownHtml } from "./markdown.ts";

function swatches(fragment: HTMLElement) {
  return [...fragment.querySelectorAll<HTMLImageElement>(".markdown-hex-color__swatch")];
}

describe("Markdown hex colors", () => {
  it("previews only six-digit hex colors without changing readable or copied text", () => {
    const source = "Palette: #abc, #AbC8, #178969, #AAbbCC80; #000000 and #FFFFFF; PR #2536.";
    const fragment = htmlFragment(toSanitizedMarkdownHtml(source));
    expect(fragment.textContent?.trim()).toBe(source);
    expect(swatches(fragment).map((image) => image.parentElement?.textContent)).toEqual([
      "#178969",
      "#000000",
      "#FFFFFF",
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
      "#ab #abcde #abcdefg #abcdefghi #123456789 #12g #abcxyz ##abcdef x#abcdef #abcdef_0 #abcdef.txt #abcdef/path",
      "`#abcdef` [#abcdef](https://example.com/#abcdef) https://example.com/#abcdef <https://example.com/#abcdef>",
      '![#abcdef](https://example.com/image.png) <span title="#abcdef">raw</span>',
      "```css\n#abcdef { color: #ffffff; }\n```",
      "    #abcdef",
    ].join("\n\n");
    const fragment = htmlFragment(toSanitizedMarkdownHtml(source));
    expect(swatches(fragment)).toHaveLength(0);
    expect(fragment.querySelector("code")?.textContent).toBe("#abcdef");
    expect(fragment.querySelector("a")?.getAttribute("href")).toBe("https://example.com/#abcdef");
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
      swatches(htmlFragment(toSanitizedMarkdownHtml("#abcdef", { mode: "document" }))),
    ).toHaveLength(0);
  });

  it("keeps unresolved item references plain while preserving numeric colors", () => {
    const source = "PR #126; issue **#1234**; pull request #123456; fixes #12345678; hex #126126.";
    for (const fragment of [
      htmlFragment(toSanitizedMarkdownHtml(source)),
      htmlFragment(toStreamingMarkdownParts(source).join("")),
    ]) {
      expect(fragment.querySelector("a")).toBeNull();
      expect(swatches(fragment).map((image) => image.parentElement?.textContent)).toEqual([
        "#126126",
      ]);
      expect(fragment.textContent?.trim()).toBe(source.replaceAll("**", ""));
    }
  });

  it("replaces partial streaming colors without retaining invalid prefixes", () => {
    const streamKey = "hex-colors-stream";
    for (const [tail, expected] of [
      ["#ab", []],
      ["#abc", []],
      ["#abcd", []],
      ["#abcde", []],
      ["#abcdef", ["#abcdef"]],
      ["#abcdefg", []],
      ["#abcdef12", []],
    ] as const) {
      const source = `Stable #ffffff.\n\nColor ${tail}`;
      const fragment = htmlFragment(toStreamingMarkdownParts(source, {}, streamKey).join(""));
      expect(swatches(fragment).map((image) => image.parentElement?.textContent)).toEqual([
        "#ffffff",
        ...expected,
      ]);
      expect(fragment.textContent?.trim()).toBe(`Stable #ffffff.\nColor ${tail}`);
    }
  });
});
