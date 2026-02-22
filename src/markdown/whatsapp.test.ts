import { describe, expect, it } from "vitest";
import { markdownToWhatsApp } from "./whatsapp.js";

describe("markdownToWhatsApp", () => {
  it("handles common markdown-to-whatsapp conversions", () => {
    const cases = [
      ["converts **bold** to *bold*", "**SOD Blast:**", "*SOD Blast:*"],
      ["converts __bold__ to *bold*", "__important__", "*important*"],
      ["converts ~~strikethrough~~ to ~strikethrough~", "~~deleted~~", "~deleted~"],
      ["leaves single *italic* unchanged (already WhatsApp bold)", "*text*", "*text*"],
      ["leaves _italic_ unchanged (already WhatsApp italic)", "_text_", "_text_"],
      ["preserves inline code", "Use `**not bold**` here", "Use `**not bold**` here"],
      [
        "handles mixed formatting",
        "**bold** and ~~strike~~ and _italic_",
        "*bold* and ~strike~ and _italic_",
      ],
      ["handles multiple bold segments", "**one** then **two**", "*one* then *two*"],
      ["returns empty string for empty input", "", ""],
      ["returns plain text unchanged", "no formatting here", "no formatting here"],
      ["handles bold inside a sentence", "This is **very** important", "This is *very* important"],
    ] as const;
    for (const [name, input, expected] of cases) {
      expect(markdownToWhatsApp(input), name).toBe(expected);
    }
  });

  it("preserves fenced code blocks", () => {
    const input = "```\nconst x = **bold**;\n```";
    expect(markdownToWhatsApp(input)).toBe(input);
  });

  it("preserves code block with formatting inside", () => {
    const input = "Before ```**bold** and ~~strike~~``` after **real bold**";
    expect(markdownToWhatsApp(input)).toBe(
      "Before ```**bold** and ~~strike~~``` after *real bold*",
    );
  });
});
