import { describe, expect, it } from "vitest";
import { findMessageDisclosureLine, type MessageTextRect } from "./chat-message-disclosure.ts";

function textRect(top: number, height = 18, lineHeight = 21): MessageTextRect {
  return { top, glyphTop: top, bottom: top + height, width: 80, lineHeight };
}

describe("findMessageDisclosureLine", () => {
  it.each([
    ["paragraph gap", [1, 22, 57, 78, 99, 120].map((top) => textRect(top)), 5, { top: 99 }],
    [
      "unordered inline fragments",
      [textRect(1), textRect(24, 14), textRect(43), textRect(22), textRect(45, 14, 24)],
      3,
      { top: 43, bottom: 61, lineHeight: 24 },
    ],
    [
      "overhanging block-art glyph",
      Array.from({ length: 8 }, (_, index) => ({
        ...textRect(index * 10.3125 + 3, 16, 10.32),
        glyphTop: index * 10.3125,
      })),
      5,
      { top: 44.25, clamp: 51.5625 },
    ],
    [
      "next glyph obscures the selected line",
      [
        ...Array.from({ length: 5 }, (_, index) => textRect(index * 21)),
        { ...textRect(105, 37), glyphTop: 97 },
      ],
      5,
      { top: 63, clamp: expect.closeTo(78.54, 6) },
    ],
  ])("finds a readable disclosure line with %s", (_name, rects, line, expected) => {
    expect(findMessageDisclosureLine(rects, line)).toMatchObject(expected);
  });

  it("ignores empty layout boxes and leaves missing lines unmeasured", () => {
    const rects = [textRect(1), { ...textRect(22), width: 0 }, textRect(43, 0)];
    expect(findMessageDisclosureLine(rects, 2)).toBeUndefined();
    expect(findMessageDisclosureLine([], 5)).toBeUndefined();
  });
});
