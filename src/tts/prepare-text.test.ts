// TTS prepare text tests cover text cleanup before speech synthesis.
import { describe, expect, it } from "vitest";
import type { FormatCapabilityProfile } from "../../packages/markdown-core/src/format-capabilities.js";
import { stripMarkdown } from "../shared/text/strip-markdown.js";

const PLAIN_PROFILE = {
  mechanism: "plain",
  constructs: {
    bold: "strip",
    italic: "strip",
    underline: "strip",
    strikethrough: "strip",
    spoiler: "strip",
    codeInline: "strip",
    codeBlock: "strip",
    codeLanguage: "strip",
    linkLabel: "fallback",
    heading: "strip",
    bulletList: "native",
    orderedList: "native",
    taskList: "fallback",
    table: "strip",
    blockquote: "strip",
    image: "strip",
    mention: "strip",
  },
  chunk: { limit: 1_600, unit: "chars" },
} satisfies FormatCapabilityProfile;

describe("TTS text preparation – stripMarkdown", () => {
  it("strips markdown headings and horizontal rules before TTS", () => {
    expect(stripMarkdown("### System Design Basics")).toBe("System Design Basics");
    expect(stripMarkdown("## Heading\nSome text")).toBe("Heading\nSome text");
    expect(stripMarkdown("Above\n---\nBelow")).toBe("Above\nBelow");
    expect(stripMarkdown("Above\n***\nBelow")).toBe("Above\n\nBelow");
  });

  it("strips bold and italic markers before TTS", () => {
    expect(stripMarkdown("This is **important** and *useful*")).toBe(
      "This is important and useful",
    );
    expect(stripMarkdown("This is __bold__ text")).toBe("This is bold text");
  });

  it("preserves underscores inside words while still stripping italic markers", () => {
    const cases = [
      ["https://cdn.example/my_file_name.png", "https://cdn.example/my_file_name.png"],
      ["e\u0301_mail_.txt", "e\u0301_mail_.txt"],
      ["_italic_ at start", "italic at start"],
      ["end _italic_", "end italic"],
      ["foo_bar _italic_ baz_qux", "foo_bar italic baz_qux"],
      ["привет_мир_тест", "привет_мир_тест"],
      ["東京_駅_前", "東京_駅_前"],
      ["var_123_end", "var_123_end"],
      ["こんにちは _italic_ テスト", "こんにちは italic テスト"],
    ] as const;
    for (const [input, expected] of cases) {
      expect(stripMarkdown(input), input).toBe(expected);
    }
  });

  it("keeps explicit link destinations readable by default", () => {
    expect(stripMarkdown("Read the [download](https://example.com/file)")).toBe(
      "Read the download (https://example.com/file)",
    );
    expect(
      stripMarkdown("Read the [download](https://example.com/file)", { linkStyle: "label" }),
    ).toBe("Read the download");
  });

  it("keeps role-header prefixes aligned after labeled link expansion", () => {
    expect(
      stripMarkdown("[docs](https://example.com)\nuser[Thu] hello", {
        assistantTranscriptRoleHeaders: true,
      }),
    ).toBe("docs (https://example.com)\n[assistant-authored transcript] user[Thu] hello");
  });

  it("applies profile-aware task and authored-HTML fallbacks before projection", () => {
    expect(stripMarkdown("- [x] done\n\n<u>under</u>", {}, PLAIN_PROFILE)).toBe(
      "[x] done\n\nunder",
    );
  });

  it("keeps explicit label-only links above profile fallback", () => {
    expect(
      stripMarkdown("Read [docs](https://example.com)", { linkStyle: "label" }, PLAIN_PROFILE),
    ).toBe("Read docs");
  });

  it("handles a typical LLM reply with mixed markdown", () => {
    const input = `## Heading with **bold** and *italic*

> A blockquote with \`code\`

Some ~~deleted~~ content.`;

    const result = stripMarkdown(input);

    expect(result).toBe(`Heading with bold and italic

A blockquote with code

Some deleted content.`);
  });
});
