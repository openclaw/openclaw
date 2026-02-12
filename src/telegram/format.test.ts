import { describe, expect, it } from "vitest";
import { markdownToTelegramHtml } from "./format.js";

describe("markdownToTelegramHtml", () => {
  it("renders basic inline formatting", () => {
    const res = markdownToTelegramHtml("hi _there_ **boss** `code`");
    expect(res).toBe("hi <i>there</i> <b>boss</b> <code>code</code>");
  });

  it("renders links as Telegram-safe HTML", () => {
    const res = markdownToTelegramHtml("see [docs](https://example.com)");
    expect(res).toBe('see <a href="https://example.com">docs</a>');
  });

  it("escapes raw HTML", () => {
    const res = markdownToTelegramHtml("<b>nope</b>");
    expect(res).toBe("&lt;b&gt;nope&lt;/b&gt;");
  });

  it("escapes unsafe characters", () => {
    const res = markdownToTelegramHtml("a & b < c");
    expect(res).toBe("a &amp; b &lt; c");
  });

  it("renders paragraphs with blank lines", () => {
    const res = markdownToTelegramHtml("first\n\nsecond");
    expect(res).toBe("first\n\nsecond");
  });

  it("renders lists without block HTML", () => {
    const res = markdownToTelegramHtml("- one\n- two");
    expect(res).toBe("• one\n• two");
  });

  it("renders ordered lists with numbering", () => {
    const res = markdownToTelegramHtml("2. two\n3. three");
    expect(res).toBe("2. two\n3. three");
  });

  it("flattens headings", () => {
    const res = markdownToTelegramHtml("# Title");
    expect(res).toBe("Title");
  });

  it("renders blockquotes as native Telegram blockquote tags", () => {
    const res = markdownToTelegramHtml("> Quote");
    expect(res).toContain("<blockquote>");
    expect(res).toContain("Quote");
    expect(res).toContain("</blockquote>");
  });

  it("renders blockquotes with inline formatting", () => {
    const res = markdownToTelegramHtml("> **bold** quote");
    expect(res).toContain("<blockquote>");
    expect(res).toContain("<b>bold</b>");
    expect(res).toContain("</blockquote>");
  });

  it("renders multiline blockquotes as a single Telegram blockquote", () => {
    const res = markdownToTelegramHtml("> first\n> second");
    expect(res).toBe("<blockquote>first\nsecond</blockquote>");
  });

  it("renders separated quoted paragraphs as distinct blockquotes", () => {
    const res = markdownToTelegramHtml("> first\n\n> second");
    expect(res).toContain("<blockquote>first");
    expect(res).toContain("<blockquote>second</blockquote>");
    expect(res.match(/<blockquote>/g)).toHaveLength(2);
  });

  it("renders fenced code blocks", () => {
    const res = markdownToTelegramHtml("```js\nconst x = 1;\n```");
    expect(res).toBe("<pre><code>const x = 1;\n</code></pre>");
  });

  it("properly nests overlapping bold and autolink (#4071)", () => {
    const res = markdownToTelegramHtml("**start https://example.com** end");
    expect(res).toMatch(
      /<b>start <a href="https:\/\/example\.com">https:\/\/example\.com<\/a><\/b> end/,
    );
  });

  it("properly nests link inside bold", () => {
    const res = markdownToTelegramHtml("**bold [link](https://example.com) text**");
    expect(res).toBe('<b>bold <a href="https://example.com">link</a> text</b>');
  });

  it("properly nests bold wrapping a link with trailing text", () => {
    const res = markdownToTelegramHtml("**[link](https://example.com) rest**");
    expect(res).toBe('<b><a href="https://example.com">link</a> rest</b>');
  });

  it("properly nests bold inside a link", () => {
    const res = markdownToTelegramHtml("[**bold**](https://example.com)");
    expect(res).toBe('<a href="https://example.com"><b>bold</b></a>');
  });

  it("renders spoiler tags", () => {
    const res = markdownToTelegramHtml("the answer is ||42||");
    expect(res).toBe("the answer is <tg-spoiler>42</tg-spoiler>");
  });

  it("renders spoiler with nested formatting", () => {
    const res = markdownToTelegramHtml("||**secret** text||");
    expect(res).toBe("<tg-spoiler><b>secret</b> text</tg-spoiler>");
  });
});
