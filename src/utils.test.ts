import { describe, expect, it } from "vitest";
import { isRecord } from "./utils.js";

describe("isRecord", () => {
  it("returns true for plain objects", () => {
    expect(isRecord({})).toBe(true);
  });
});
