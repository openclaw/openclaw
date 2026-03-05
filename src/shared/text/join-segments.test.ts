import { describe, expect, it } from "vitest";
import { concatOptionalTextSegments, joinPresentTextSegments } from "./join-segments.js";

describe("concatOptionalTextSegments", () => {
  it("concatenates left and right with default separator", () => {
    expect(concatOptionalTextSegments({ left: "A", right: "B" })).toBe("A\n\nB");
  });

  it("keeps explicit empty-string right value", () => {
    expect(concatOptionalTextSegments({ left: "A", right: "" })).toBe("");
  });
});

describe("joinPresentTextSegments", () => {
  it("joins non-empty segments", () => {
    expect(joinPresentTextSegments(["A", undefined, "B"])).toBe("A\n\nB");
  });

  it("returns undefined when all segments are empty", () => {
    expect(joinPresentTextSegments(["", undefined, null])).toBeUndefined();
  });

  it("trims segments when requested", () => {
    expect(joinPresentTextSegments(["  A  ", "  B  "], { trim: true })).toBe("A\n\nB");
  });

  it("uses custom separator and skips whitespace-only segments after trim", () => {
    expect(
      joinPresentTextSegments(["  keep  ", "   ", "next"], {
        trim: true,
        separator: " | ",
      }),
    ).toBe("keep | next");
  });
});
