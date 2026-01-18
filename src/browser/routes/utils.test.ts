import { describe, expect, it } from "vitest";

import { toBoolean } from "./utils.js";

describe("toBoolean", () => {
  it("parses yes/no and 1/0", () => {
    expect(toBoolean("yes")).toBe(true);
    expect(toBoolean("1")).toBe(true);
    expect(toBoolean("no")).toBe(false);
    expect(toBoolean("0")).toBe(false);
  });

  it("returns undefined for on/off strings", () => {
    expect(toBoolean("on")).toBeUndefined();
    expect(toBoolean("off")).toBeUndefined();
  });

  it("passes through boolean values", () => {
    expect(toBoolean(true)).toBe(true);
    expect(toBoolean(false)).toBe(false);
  });
});
