import { describe, expect, it } from "vitest";
import { appendOutputWithCap } from "./output-cap.js";

describe("appendOutputWithCap", () => {
  it("keeps full output when under cap", () => {
    expect(appendOutputWithCap("abc", "def", 10)).toEqual({
      text: "abcdef",
      truncated: false,
    });
  });

  it("keeps the prefix when output exceeds cap", () => {
    expect(appendOutputWithCap('[{"docid":1}', ',{"docid":2}]', 12)).toEqual({
      text: '[{"docid":1}',
      truncated: true,
    });
  });
});
