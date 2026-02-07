import { describe, expect, it } from "vitest";
import { buildCodeSpanIndex, createInlineCodeState } from "./code-spans.js";

describe("createInlineCodeState", () => {
  it("returns closed state", () => {
    const state = createInlineCodeState();
    expect(state.open).toBe(false);
    expect(state.ticks).toBe(0);
  });
});

describe("buildCodeSpanIndex", () => {
  it("marks nothing inside for plain text", () => {
    const idx = buildCodeSpanIndex("hello world");
    expect(idx.isInside(0)).toBe(false);
    expect(idx.isInside(5)).toBe(false);
  });

  it("marks inline code as inside", () => {
    const text = "before `code` after";
    const idx = buildCodeSpanIndex(text);
    // Characters inside backtick span should be "inside"
    const codeStart = text.indexOf("`");
    const codeEnd = text.lastIndexOf("`") + 1;
    expect(idx.isInside(codeStart)).toBe(true);
    expect(idx.isInside(codeStart + 1)).toBe(true);
    // Outside the span
    expect(idx.isInside(0)).toBe(false);
    expect(idx.isInside(codeEnd)).toBe(false);
  });

  it("marks fenced code blocks as inside", () => {
    const text = "before\n```\ncode line\n```\nafter";
    const idx = buildCodeSpanIndex(text);
    const codePos = text.indexOf("code line");
    expect(idx.isInside(codePos)).toBe(true);
    // "after" is outside the fence
    const afterPos = text.indexOf("after");
    expect(idx.isInside(afterPos)).toBe(false);
  });

  it("handles double backtick inline code", () => {
    const text = "``code here`` rest";
    const idx = buildCodeSpanIndex(text);
    expect(idx.isInside(2)).toBe(true); // inside ``...``
    expect(idx.isInside(text.indexOf("rest"))).toBe(false);
  });

  it("tracks state across calls for unclosed spans", () => {
    const text1 = "start `open";
    const idx1 = buildCodeSpanIndex(text1);
    expect(idx1.inlineState.open).toBe(true);
    expect(idx1.inlineState.ticks).toBe(1);
  });

  it("continues with provided inline state", () => {
    const text = "continued` after";
    const state = { open: true, ticks: 1 };
    const idx = buildCodeSpanIndex(text, state);
    // From start to the closing backtick should be "inside" (continuation of open span)
    expect(idx.isInside(0)).toBe(true);
    // After closing backtick
    const afterPos = text.indexOf("after");
    expect(idx.isInside(afterPos)).toBe(false);
  });
});
