import { describe, expect, it } from "vitest";
import { stripHtmlForPlainText } from "./strip-html.js";

describe("stripHtmlForPlainText", () => {
  it("converts <br> to newline", () => {
    expect(stripHtmlForPlainText("hello<br>world")).toBe("hello\nworld");
    expect(stripHtmlForPlainText("hello<br/>world")).toBe("hello\nworld");
    expect(stripHtmlForPlainText("hello<br />world")).toBe("hello\nworld");
  });

  it("strips bold tags", () => {
    expect(stripHtmlForPlainText("<b>bold</b>")).toBe("bold");
    expect(stripHtmlForPlainText("<strong>bold</strong>")).toBe("bold");
  });

  it("strips italic tags", () => {
    expect(stripHtmlForPlainText("<i>italic</i>")).toBe("italic");
    expect(stripHtmlForPlainText("<em>italic</em>")).toBe("italic");
  });

  it("strips strikethrough tags", () => {
    expect(stripHtmlForPlainText("<s>strike</s>")).toBe("strike");
    expect(stripHtmlForPlainText("<del>deleted</del>")).toBe("deleted");
  });

  it("converts paragraph breaks", () => {
    expect(stripHtmlForPlainText("<p>first</p><p>second</p>")).toContain("first");
    expect(stripHtmlForPlainText("<p>first</p><p>second</p>")).toContain("second");
  });

  it("strips remaining HTML tags", () => {
    expect(stripHtmlForPlainText('<a href="url">link</a>')).toBe("link");
    expect(stripHtmlForPlainText("<span class='x'>text</span>")).toBe("text");
  });

  it("decodes common HTML entities", () => {
    expect(stripHtmlForPlainText("&amp; &lt; &gt; &quot; &#39;")).toBe("& < > \" '");
  });

  it("collapses excessive newlines", () => {
    expect(stripHtmlForPlainText("a<br><br><br><br>b")).toBe("a\n\nb");
  });

  it("returns plain text unchanged", () => {
    expect(stripHtmlForPlainText("hello world")).toBe("hello world");
  });

  it("handles empty string", () => {
    expect(stripHtmlForPlainText("")).toBe("");
  });

  it("handles &nbsp;", () => {
    expect(stripHtmlForPlainText("hello&nbsp;world")).toBe("hello world");
  });
});
