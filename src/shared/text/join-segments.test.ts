import { describe, expect, it } from "vitest";
import { concatOptionalTextSegments, joinPresentTextSegments } from "./join-segments.js";

describe("concatOptionalTextSegments", () => {
  it.each([
    { params: { left: "A", right: "" }, expected: "" },
    { params: { left: "A" }, expected: "A" },
    { params: { right: "B" }, expected: "B" },
    { params: { left: "", right: "B" }, expected: "B" },
    { params: { left: "" }, expected: "" },
  ] as const)("concatenates optional segments %#", ({ params, expected }) => {
    expect(concatOptionalTextSegments(params)).toBe(expected);
  });
});

describe("joinPresentTextSegments", () => {
  it.each([
    { segments: ["A", undefined, "B"], options: undefined, expected: "A\n\nB" },
    { segments: ["", undefined, null], options: undefined, expected: undefined },
    { segments: ["  A  ", "  B  "], options: { trim: true }, expected: "A\n\nB" },
    {
      segments: ["A", "   ", "B"],
      options: undefined,
      expected: "A\n\n   \n\nB",
    },
    {
      segments: ["A", "   ", "B"],
      options: { trim: true },
      expected: "A\n\nB",
    },
    { segments: ["A", "  B  "], options: undefined, expected: "A\n\n  B  " },
  ] as const)("joins present segments %#", ({ segments, options, expected }) => {
    expect(joinPresentTextSegments(segments, options)).toBe(expected);
  });
});
