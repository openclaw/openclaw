import { describe, expect, it } from "vitest";
import { transformMarkdownForWhatsApp } from "./whatsapp.js";

describe("transformMarkdownForWhatsApp", () => {
  describe("bold conversion", () => {
    it("converts **bold** to *bold*", () => {
      expect(transformMarkdownForWhatsApp("hello **world**")).toBe("hello *world*");
    });

    it("converts __bold__ to *bold*", () => {
      expect(transformMarkdownForWhatsApp("hello __world__")).toBe("hello *world*");
    });

    it("handles multiple bold segments", () => {
      expect(transformMarkdownForWhatsApp("**one** and **two**")).toBe("*one* and *two*");
    });

    it("preserves already-correct WhatsApp bold", () => {
      expect(transformMarkdownForWhatsApp("hello *world*")).toBe("hello *world*");
    });
  });

  describe("strikethrough conversion", () => {
    it("converts ~~strike~~ to ~strike~", () => {
      expect(transformMarkdownForWhatsApp("hello ~~world~~")).toBe("hello ~world~");
    });

    it("handles multiple strikethrough segments", () => {
      expect(transformMarkdownForWhatsApp("~~one~~ and ~~two~~")).toBe("~one~ and ~two~");
    });
  });

  describe("header conversion", () => {
    it("converts # header to *header*", () => {
      expect(transformMarkdownForWhatsApp("# Hello")).toBe("*Hello*");
    });

    it("converts ## header to *header*", () => {
      expect(transformMarkdownForWhatsApp("## Hello")).toBe("*Hello*");
    });

    it("converts ### header to *header*", () => {
      expect(transformMarkdownForWhatsApp("### Hello")).toBe("*Hello*");
    });

    it("handles headers in multiline text", () => {
      const input = "# Title\n\nSome text\n\n## Subtitle";
      const expected = "*Title*\n\nSome text\n\n*Subtitle*";
      expect(transformMarkdownForWhatsApp(input)).toBe(expected);
    });
  });

  describe("link conversion", () => {
    it("converts [text](url) to text (url)", () => {
      expect(transformMarkdownForWhatsApp("[docs](https://example.com)")).toBe(
        "docs (https://example.com)",
      );
    });

    it("shows just URL when text matches URL", () => {
      expect(transformMarkdownForWhatsApp("[https://example.com](https://example.com)")).toBe(
        "https://example.com",
      );
    });

    it("handles multiple links", () => {
      const input = "Check [docs](https://a.com) and [help](https://b.com)";
      const expected = "Check docs (https://a.com) and help (https://b.com)";
      expect(transformMarkdownForWhatsApp(input)).toBe(expected);
    });
  });

  describe("image conversion", () => {
    it("converts ![alt](url) to alt (url)", () => {
      expect(transformMarkdownForWhatsApp("![screenshot](https://img.com/a.png)")).toBe(
        "screenshot (https://img.com/a.png)",
      );
    });

    it("shows just URL when alt is empty", () => {
      expect(transformMarkdownForWhatsApp("![](https://img.com/a.png)")).toBe(
        "https://img.com/a.png",
      );
    });
  });

  describe("horizontal rule removal", () => {
    it("removes ---", () => {
      expect(transformMarkdownForWhatsApp("before\n---\nafter")).toBe("before\n\nafter");
    });

    it("removes ***", () => {
      expect(transformMarkdownForWhatsApp("before\n***\nafter")).toBe("before\n\nafter");
    });

    it("removes ___", () => {
      expect(transformMarkdownForWhatsApp("before\n___\nafter")).toBe("before\n\nafter");
    });
  });

  describe("blank line collapsing", () => {
    it("collapses 3+ blank lines to 2", () => {
      expect(transformMarkdownForWhatsApp("a\n\n\n\nb")).toBe("a\n\nb");
    });

    it("preserves 2 blank lines", () => {
      expect(transformMarkdownForWhatsApp("a\n\nb")).toBe("a\n\nb");
    });
  });

  describe("code block preservation", () => {
    it("preserves fenced code blocks", () => {
      const input = "```js\nconst **x** = 1;\n```";
      expect(transformMarkdownForWhatsApp(input)).toBe(input);
    });

    it("preserves inline code", () => {
      const input = "Use `**bold**` for emphasis";
      expect(transformMarkdownForWhatsApp(input)).toBe("Use `**bold**` for emphasis");
    });

    it("transforms text outside code blocks", () => {
      const input = "**bold** then ```code``` then **more**";
      expect(transformMarkdownForWhatsApp(input)).toBe("*bold* then ```code``` then *more*");
    });
  });

  describe("combined transformations", () => {
    it("handles a complex message", () => {
      const input = `# Welcome

Hello **world**! Check out [our docs](https://docs.example.com).

## Features

- ~~Old feature~~
- __New feature__

---

Thanks!`;

      const expected = `*Welcome*

Hello *world*! Check out our docs (https://docs.example.com).

*Features*

- ~Old feature~
- *New feature*

Thanks!`;

      expect(transformMarkdownForWhatsApp(input)).toBe(expected);
    });
  });

  describe("edge cases", () => {
    it("handles empty string", () => {
      expect(transformMarkdownForWhatsApp("")).toBe("");
    });

    it("handles null-ish input", () => {
      expect(transformMarkdownForWhatsApp(null as unknown as string)).toBe(null);
      expect(transformMarkdownForWhatsApp(undefined as unknown as string)).toBe(undefined);
    });

    it("handles plain text without markdown", () => {
      expect(transformMarkdownForWhatsApp("Hello world")).toBe("Hello world");
    });
  });
});
