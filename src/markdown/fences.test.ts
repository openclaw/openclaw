import { describe, expect, it } from "vitest";
import { findFenceSpanAt, isSafeFenceBreak, parseFenceSpans } from "./fences.js";

describe("parseFenceSpans", () => {
  it("parses backtick fenced code block", () => {
    const input = "before\n```js\ncode\n```\nafter";
    const spans = parseFenceSpans(input);
    expect(spans).toHaveLength(1);
    expect(input.slice(spans[0].start, spans[0].end)).toBe("```js\ncode\n```");
    expect(spans[0].marker).toBe("```");
  });

  it("parses tilde fenced code block", () => {
    const input = "~~~\ncode\n~~~";
    const spans = parseFenceSpans(input);
    expect(spans).toHaveLength(1);
  });

  it("requires matching fence type", () => {
    const input = "```\ncode\n~~~\n```";
    const spans = parseFenceSpans(input);
    expect(spans).toHaveLength(1);
    // ~~~ is not a matching close for ```, so ``` closes it
    expect(input.slice(spans[0].start, spans[0].end)).toBe("```\ncode\n~~~\n```");
  });

  it("handles unclosed fence as extending to end", () => {
    const input = "```\ncode\nno close";
    const spans = parseFenceSpans(input);
    expect(spans).toHaveLength(1);
    expect(spans[0].end).toBe(input.length);
  });

  it("parses multiple fenced blocks", () => {
    const input = "```\na\n```\ntext\n```\nb\n```";
    const spans = parseFenceSpans(input);
    expect(spans).toHaveLength(2);
  });

  it("handles empty input", () => {
    expect(parseFenceSpans("")).toEqual([]);
  });

  it("handles no fences", () => {
    expect(parseFenceSpans("just plain text")).toEqual([]);
  });

  it("closing fence must have >= same marker length", () => {
    const input = "````\ncode\n```\n````";
    const spans = parseFenceSpans(input);
    expect(spans).toHaveLength(1);
    // ``` (3) < ```` (4), so doesn't close. ```` (4) >= ```` (4), closes.
    expect(input.slice(spans[0].start, spans[0].end)).toBe("````\ncode\n```\n````");
  });
});

describe("findFenceSpanAt", () => {
  it("finds span containing index (exclusive of boundaries)", () => {
    const input = "```\ncode\n```";
    const spans = parseFenceSpans(input);
    // index 0 is start, not inside (> start required)
    expect(findFenceSpanAt(spans, 0)).toBeUndefined();
    // index 4 is inside
    expect(findFenceSpanAt(spans, 4)).toBeDefined();
  });

  it("returns undefined outside spans", () => {
    const input = "text\n```\ncode\n```\ntext";
    const spans = parseFenceSpans(input);
    expect(findFenceSpanAt(spans, 0)).toBeUndefined();
  });
});

describe("isSafeFenceBreak", () => {
  it("returns true outside fences", () => {
    const input = "text\n```\ncode\n```\nmore";
    const spans = parseFenceSpans(input);
    expect(isSafeFenceBreak(spans, 0)).toBe(true);
  });

  it("returns false inside fence", () => {
    const input = "```\ncode\n```";
    const spans = parseFenceSpans(input);
    expect(isSafeFenceBreak(spans, 5)).toBe(false);
  });
});
