import { describe, expect, it } from "vitest";
import { findMessageDisclosureLine, type MessageTextRect } from "./chat-message-disclosure.ts";

function textRect(top: number, height = 18, lineHeight = 21): MessageTextRect {
  return { top, glyphTop: top, bottom: top + height, width: 80, lineHeight };
}

describe("findMessageDisclosureLine", () => {
  it("keeps the actual fifth line position across a paragraph gap", () => {
    const rects = [1, 22, 57, 78, 99, 120].map((top) => textRect(top));
    expect(findMessageDisclosureLine(rects, 5)?.top).toBe(99);
  });

  it("combines inline fragments with different font metrics regardless of their DOM order", () => {
    const rects = [textRect(1), textRect(24, 14), textRect(43), textRect(22), textRect(45, 14, 24)];
    expect(findMessageDisclosureLine(rects, 3)).toMatchObject({
      top: 43,
      bottom: 61,
      lineHeight: 24,
    });
  });

  it("ignores empty layout boxes and leaves missing lines unmeasured", () => {
    const rects = [textRect(1), { ...textRect(22), width: 0 }, textRect(43, 0)];
    expect(findMessageDisclosureLine(rects, 2)).toBeUndefined();
    expect(findMessageDisclosureLine([], 5)).toBeUndefined();
  });

  it("clips before the next block-art glyph even when it overhangs its line box", () => {
    const rects = Array.from({ length: 8 }, (_, index) => ({
      ...textRect(index * 10.3125 + 3, 16, 10.32),
      glyphTop: index * 10.3125,
    }));
    expect(findMessageDisclosureLine(rects, 5)).toMatchObject({
      top: 44.25,
      clamp: 51.5625,
    });
  });

  it("backs up when excluding the next glyph would hide too much of the selected line", () => {
    const rects = Array.from({ length: 6 }, (_, index) => textRect(index * 21));
    rects[5] = { ...textRect(105, 37), glyphTop: 97 };
    const line = findMessageDisclosureLine(rects, 5);
    expect(line?.top).toBe(63);
    expect(line?.clamp).toBeCloseTo(78.54, 6);
  });
});
