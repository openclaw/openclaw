import { describe, expect, it } from "vitest";
import { parseConfigPathArrayIndex } from "./path-array-index.js";

describe("parseConfigPathArrayIndex", () => {
  it("parses the zero index", () => {
    expect(parseConfigPathArrayIndex("0")).toBe(0);
  });

  it("rejects indexes exceeding the max bound", () => {
    expect(parseConfigPathArrayIndex("100001")).toBeUndefined();
  });

  it("rejects negative indexes", () => {
    expect(parseConfigPathArrayIndex("-1")).toBeUndefined();
    expect(parseConfigPathArrayIndex("-0")).toBeUndefined();
  });
});
