import { describe, expect, it } from "vitest";
import { sanitizeUserText } from "./sanitize.js";

describe("sanitizeUserText", () => {
  it("trims before enforcing maxLength", () => {
    expect(sanitizeUserText("   abc   ", 3)).toBe("abc");
  });

  it("strips control chars", () => {
    expect(sanitizeUserText("a\n\tb\u0000c")).toBe("abc");
  });
});
