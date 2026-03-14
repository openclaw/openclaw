import { describe, expect, it } from "vitest";
import { chunkMarkdownIR, markdownToIR, markdownToIRWithMeta } from "./ir.js";
import type { MarkdownIR } from "./ir.js";

describe("markdown IR chunking helpers", () => {
  it("emits spoiler spans when enableSpoilers is true", () => {
    const { ir, hasTables } = markdownToIRWithMeta("before ||secret|| after", {
      enableSpoilers: true,
    });

    expect(hasTables).toBe(false);
    expect(ir.text).toBe("before secret after");
    expect(ir.styles).toEqual([{ start: 7, end: 13, style: "spoiler" }]);
  });

  it("merges adjacent bold spans from parsed markdown", () => {
    const ir = markdownToIR("**one**__two__");

    expect(ir.text).toBe("onetwo");
    expect(ir.styles).toEqual([{ start: 0, end: 6, style: "bold" }]);
  });

  it("returns fast-path chunk results for empty, non-positive, and already-fitting input", () => {
    const empty: MarkdownIR = { text: "", styles: [], links: [] };
    const short: MarkdownIR = { text: "short", styles: [], links: [] };

    expect(chunkMarkdownIR(empty, 4)).toEqual([]);
    expect(chunkMarkdownIR(short, 0)).toEqual([short]);
    expect(chunkMarkdownIR(short, 10)).toEqual([short]);
    expect(chunkMarkdownIR(short, 0)[0]).toBe(short);
    expect(chunkMarkdownIR(short, 10)[0]).toBe(short);
  });

  it("slices styles and links across chunks, merges inline spans, and keeps blockquotes separate", () => {
    const ir: MarkdownIR = {
      text: "abcd efgh",
      styles: [
        { start: 0, end: 2, style: "bold" },
        { start: 2, end: 4, style: "bold" },
        { start: 5, end: 7, style: "blockquote" },
        { start: 7, end: 9, style: "blockquote" },
      ],
      links: [{ start: 5, end: 9, href: "https://example.com" }],
    };

    expect(chunkMarkdownIR(ir, 5)).toEqual([
      {
        text: "abcd",
        styles: [{ start: 0, end: 4, style: "bold" }],
        links: [],
      },
      {
        text: "efgh",
        styles: [
          { start: 0, end: 2, style: "blockquote" },
          { start: 2, end: 4, style: "blockquote" },
        ],
        links: [{ start: 0, end: 4, href: "https://example.com" }],
      },
    ]);
  });
});
