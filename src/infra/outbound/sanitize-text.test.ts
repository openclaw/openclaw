import { describe, expect, it } from "vitest";
import { isPlainTextSurface, sanitizeForPlainText, shouldStripMarkdown } from "./sanitize-text.js";

// ---------------------------------------------------------------------------
// isPlainTextSurface
// ---------------------------------------------------------------------------

describe("isPlainTextSurface", () => {
  it.each(["whatsapp", "signal", "sms", "irc", "telegram", "imessage", "googlechat"])(
    "returns true for %s",
    (channel) => {
      expect(isPlainTextSurface(channel)).toBe(true);
    },
  );

  it.each(["discord", "slack", "web", "matrix"])("returns false for %s", (channel) => {
    expect(isPlainTextSurface(channel)).toBe(false);
  });

  it("is case-insensitive", () => {
    expect(isPlainTextSurface("WhatsApp")).toBe(true);
    expect(isPlainTextSurface("SIGNAL")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// sanitizeForPlainText
// ---------------------------------------------------------------------------

describe("sanitizeForPlainText", () => {
  // --- line breaks --------------------------------------------------------

  it("converts <br> to newline", () => {
    expect(sanitizeForPlainText("hello<br>world")).toBe("hello\nworld");
  });

  it("converts self-closing <br/> and <br /> variants", () => {
    expect(sanitizeForPlainText("a<br/>b")).toBe("a\nb");
    expect(sanitizeForPlainText("a<br />b")).toBe("a\nb");
  });

  // --- inline formatting --------------------------------------------------

  it("converts <b> and <strong> to WhatsApp bold", () => {
    expect(sanitizeForPlainText("<b>bold</b>")).toBe("*bold*");
    expect(sanitizeForPlainText("<strong>bold</strong>")).toBe("*bold*");
  });

  it("converts <i> and <em> to WhatsApp italic", () => {
    expect(sanitizeForPlainText("<i>italic</i>")).toBe("_italic_");
    expect(sanitizeForPlainText("<em>italic</em>")).toBe("_italic_");
  });

  it("converts <s>, <strike>, and <del> to WhatsApp strikethrough", () => {
    expect(sanitizeForPlainText("<s>deleted</s>")).toBe("~deleted~");
    expect(sanitizeForPlainText("<del>removed</del>")).toBe("~removed~");
    expect(sanitizeForPlainText("<strike>old</strike>")).toBe("~old~");
  });

  it("converts <code> to backtick wrapping", () => {
    expect(sanitizeForPlainText("<code>foo()</code>")).toBe("`foo()`");
  });

  // --- block elements -----------------------------------------------------

  it("converts <p> and <div> to newlines", () => {
    expect(sanitizeForPlainText("<p>paragraph</p>")).toBe("\nparagraph\n");
  });

  it("converts headings to bold text with newlines", () => {
    expect(sanitizeForPlainText("<h1>Title</h1>")).toBe("\n*Title*\n");
    expect(sanitizeForPlainText("<h3>Section</h3>")).toBe("\n*Section*\n");
  });

  it("converts <li> to bullet points", () => {
    expect(sanitizeForPlainText("<li>item one</li><li>item two</li>")).toBe(
      "• item one\n• item two\n",
    );
  });

  // --- tag stripping ------------------------------------------------------

  it("strips unknown/remaining tags", () => {
    expect(sanitizeForPlainText('<span class="x">text</span>')).toBe("text");
    expect(sanitizeForPlainText('<a href="https://example.com">link</a>')).toBe("link");
  });

  it("preserves angle-bracket autolinks", () => {
    expect(sanitizeForPlainText("See <https://example.com/path?q=1> now")).toBe(
      "See https://example.com/path?q=1 now",
    );
  });

  // --- passthrough --------------------------------------------------------

  it("passes through clean text unchanged", () => {
    expect(sanitizeForPlainText("hello world")).toBe("hello world");
  });

  it("does not corrupt angle brackets in prose", () => {
    // `a < b` does not match `<tag>` pattern because there is no closing `>`
    // immediately after a tag-like sequence.
    expect(sanitizeForPlainText("a < b && c > d")).toBe("a < b && c > d");
  });

  // --- mixed content ------------------------------------------------------

  it("handles mixed HTML content", () => {
    const input = "Hello<br><b>world</b> this is <i>nice</i>";
    expect(sanitizeForPlainText(input)).toBe("Hello\n*world* this is _nice_");
  });

  it("collapses excessive newlines", () => {
    expect(sanitizeForPlainText("a<br><br><br><br>b")).toBe("a\n\nb");
  });
});

// ---------------------------------------------------------------------------
// shouldStripMarkdown
// ---------------------------------------------------------------------------

describe("shouldStripMarkdown", () => {
  it("returns true for iMessage (auto-detect)", () => {
    expect(shouldStripMarkdown("imessage")).toBe(true);
  });

  it("returns true for sms (auto-detect)", () => {
    expect(shouldStripMarkdown("sms")).toBe(true);
  });

  it("returns false for discord (auto-detect)", () => {
    expect(shouldStripMarkdown("discord")).toBe(false);
  });

  it("returns false for slack (auto-detect)", () => {
    expect(shouldStripMarkdown("slack")).toBe(false);
  });

  it("returns true when strip is explicitly true on a markdown-capable channel", () => {
    expect(shouldStripMarkdown("discord", { strip: true })).toBe(true);
  });

  it("returns false when strip is explicitly false on a non-markdown channel", () => {
    expect(shouldStripMarkdown("imessage", { strip: false })).toBe(false);
  });

  it("returns true for auto with non-markdown channel", () => {
    expect(shouldStripMarkdown("imessage", { strip: "auto" })).toBe(true);
  });

  it("returns false for auto with markdown-capable channel", () => {
    expect(shouldStripMarkdown("discord", { strip: "auto" })).toBe(false);
  });

  it("treats undefined strip as auto", () => {
    expect(shouldStripMarkdown("imessage", {})).toBe(true);
    expect(shouldStripMarkdown("discord", {})).toBe(false);
  });
});
