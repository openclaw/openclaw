import { describe, expect, it } from "vitest";
import { TerminalOutputRing } from "./output-ring.js";

function ring(cap: number, ...chunks: string[]): TerminalOutputRing {
  const buffer = new TerminalOutputRing(cap);
  for (const chunk of chunks) {
    buffer.push(chunk);
  }
  return buffer;
}

describe("TerminalOutputRing cursor paging", () => {
  it("counts accepted output so cursors survive eviction", () => {
    const buffer = ring(8, "abcdefgh", "ij");

    expect(buffer.snapshot()).toBe("ij");
    expect(buffer.readPage({ maxChars: 8 })).toEqual({
      raw: "ij",
      startCursor: 8,
      nextCursor: 10,
      endCursor: 10,
      truncated: false,
      hasMore: false,
    });
  });

  it("flags a cursor below retained output as truncated", () => {
    const buffer = ring(8, "abcdefgh", "ij");

    expect(buffer.readPage({ cursor: 0, maxChars: 8 })).toEqual({
      raw: "ij",
      startCursor: 8,
      nextCursor: 10,
      endCursor: 10,
      truncated: true,
      hasMore: false,
    });
  });

  it("pages forward from a cursor and reports remaining output", () => {
    const buffer = ring(64, "0123456789");

    expect(buffer.readPage({ cursor: 2, maxChars: 4 })).toEqual({
      raw: "2345",
      startCursor: 2,
      nextCursor: 6,
      endCursor: 10,
      truncated: false,
      hasMore: true,
    });
  });

  it("defaults to the newest page and reports where that page starts", () => {
    const buffer = ring(64, "0123456789");

    expect(buffer.readPage({ maxChars: 4 })).toEqual({
      raw: "6789",
      startCursor: 6,
      nextCursor: 10,
      endCursor: 10,
      truncated: false,
      hasMore: false,
    });
  });

  it("never splits a surrogate pair across pages and always makes progress", () => {
    const buffer = ring(16, "A\u{1f642}B");

    // A one-unit page that would cut the pair widens to carry the whole glyph.
    const first = buffer.readPage({ cursor: 0, maxChars: 2 });
    expect(first).toMatchObject({ raw: "A", startCursor: 0, nextCursor: 1 });
    expect(buffer.readPage({ cursor: first.nextCursor, maxChars: 1 })).toMatchObject({
      raw: "\u{1f642}",
      startCursor: 1,
      nextCursor: 3,
    });
  });

  it("pulls a page start back off a cursor that landed inside a pair", () => {
    const buffer = ring(16, "A\u{1f642}B");

    expect(buffer.readPage({ cursor: 2, maxChars: 8 })).toMatchObject({
      raw: "\u{1f642}B",
      startCursor: 1,
      nextCursor: 4,
      truncated: false,
    });
  });

  it("returns an empty page for a cursor past the newest output", () => {
    const buffer = ring(64, "0123456789");

    expect(buffer.readPage({ cursor: 99, maxChars: 4 })).toEqual({
      raw: "",
      startCursor: 10,
      nextCursor: 10,
      endCursor: 10,
      truncated: false,
      hasMore: false,
    });
  });
});
