import { describe, expect, it } from "vitest";
import { buildCodeSpanIndex, createInlineCodeState } from "./code-spans.js";

describe("buildCodeSpanIndex", () => {
  it("detects inline code spans", () => {
    const text = "before `code` after";
    const index = buildCodeSpanIndex(text);
    // inside backticks
    expect(index.isInside(8)).toBe(true); // 'c' of code
    // outside backticks
    expect(index.isInside(0)).toBe(false);
    expect(index.isInside(14)).toBe(false);
  });

  it("detects fenced code blocks", () => {
    const text = "text\n```\ncode\n```\nafter";
    const index = buildCodeSpanIndex(text);
    expect(index.isInside(9)).toBe(true); // inside fence
    expect(index.isInside(0)).toBe(false); // before fence
  });

  it("handles double backtick inline code", () => {
    const text = "say ``hello ` world`` done";
    const index = buildCodeSpanIndex(text);
    expect(index.isInside(6)).toBe(true); // inside ``...``
    expect(index.isInside(22)).toBe(false); // after
  });

  it("handles empty input", () => {
    const index = buildCodeSpanIndex("");
    expect(index.isInside(0)).toBe(false);
  });

  it("tracks state across calls for streaming", () => {
    const state = createInlineCodeState();
    const first = buildCodeSpanIndex("`hello", state);
    // unclosed backtick — entire rest is "inside"
    expect(first.isInside(1)).toBe(true);
    expect(first.inlineState.open).toBe(true);
  });
});
