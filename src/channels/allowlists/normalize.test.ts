import { describe, expect, it } from "vitest";
import { normalizeAllowList, stripChannelPrefix } from "./normalize.js";

describe("normalizeAllowList", () => {
  it("trims entries and drops blanks", () => {
    expect(normalizeAllowList([" a ", "", "  ", "b"])).toEqual(["a", "b"]);
  });

  it("returns an empty array for nullish input", () => {
    expect(normalizeAllowList()).toEqual([]);
    expect(normalizeAllowList(null)).toEqual([]);
  });
});

describe("stripChannelPrefix", () => {
  it("removes a matching prefix", () => {
    expect(stripChannelPrefix("tg:123", /^(telegram|tg):/i)).toBe("123");
  });

  it("returns the original value when no prefix matches", () => {
    expect(stripChannelPrefix("123", /^(telegram|tg):/i)).toBe("123");
  });
});
