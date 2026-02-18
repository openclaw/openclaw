import { describe, expect, it } from "vitest";
import { markdownToWhatsApp } from "./whatsapp.js";

describe("markdownToWhatsApp", () => {
  it("converts **bold** to *bold*", () => {
    expect(markdownToWhatsApp("**SOD Blast:**")).toBe("*SOD Blast:*");
  });

  it("converts __bold__ to *bold*", () => {
    expect(markdownToWhatsApp("__important__")).toBe("*important*");
  });

  it("converts ~~strikethrough~~ to ~strikethrough~", () => {
    expect(markdownToWhatsApp("~~deleted~~")).toBe("~deleted~");
  });

  it("leaves single *italic* unchanged (already WhatsApp bold)", () => {
    expect(markdownToWhatsApp("*text*")).toBe("*text*");
  });

  it("leaves _italic_ unchanged (already WhatsApp italic)", () => {
    expect(markdownToWhatsApp("_text_")).toBe("_text_");
  });

  it("preserves fenced code blocks", () => {
    const input = "```\nconst x = **bold**;\n```";
    expect(markdownToWhatsApp(input)).toBe(input);
  });

  it("preserves inline code", () => {
    expect(markdownToWhatsApp("Use `**not bold**` here")).toBe("Use `**not bold**` here");
  });

  it("handles mixed formatting", () => {
    expect(markdownToWhatsApp("**bold** and ~~strike~~ and _italic_")).toBe(
      "*bold* and ~strike~ and _italic_",
    );
  });

  it("handles multiple bold segments", () => {
    expect(markdownToWhatsApp("**one** then **two**")).toBe("*one* then *two*");
  });

  it("returns empty string for empty input", () => {
    expect(markdownToWhatsApp("")).toBe("");
  });

  it("returns plain text unchanged", () => {
    expect(markdownToWhatsApp("no formatting here")).toBe("no formatting here");
  });

  it("handles bold inside a sentence", () => {
    expect(markdownToWhatsApp("This is **very** important")).toBe("This is *very* important");
  });

  it("preserves code block with formatting inside", () => {
    const input = "Before ```**bold** and ~~strike~~``` after **real bold**";
    expect(markdownToWhatsApp(input)).toBe(
      "Before ```**bold** and ~~strike~~``` after *real bold*",
    );
  });
});
