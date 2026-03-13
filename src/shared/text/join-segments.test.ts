import { describe, expect, it } from "vitest";
import { concatOptionalTextSegments, joinPresentTextSegments } from "./join-segments.js";

describe("concatOptionalTextSegments", () => {
  it("concatenates left and right with default separator", () => {
    expect(concatOptionalTextSegments({ left: "A", right: "B" })).toBe("A\n\nB");
  });

  it("keeps explicit empty-string right value", () => {
    expect(concatOptionalTextSegments({ left: "A", right: "" })).toBe("");
  });

  it("falls back to whichever side is present and honors custom separators", () => {
    expect(concatOptionalTextSegments({ left: "A" })).toBe("A");
    expect(concatOptionalTextSegments({ right: "B" })).toBe("B");
    expect(concatOptionalTextSegments({ left: "A", right: "B", separator: " | " })).toBe("A | B");
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

  it("keeps whitespace-only segments unless trim is enabled and supports custom separators", () => {
    expect(joinPresentTextSegments(["A", "   ", "B"], { separator: " | " })).toBe("A |     | B");
    expect(joinPresentTextSegments(["A", "   ", "B"], { trim: true, separator: " | " })).toBe(
      "A | B",
    );
  });
});
