import { describe, expect, it } from "vitest";
import { normalizeOutboundThreadId } from "./thread-id.js";

describe("normalizeOutboundThreadId", () => {
  it("returns undefined for missing values", () => {
    expect(normalizeOutboundThreadId()).toBeUndefined();
    expect(normalizeOutboundThreadId(null)).toBeUndefined();
    expect(normalizeOutboundThreadId("   ")).toBeUndefined();
  });

  it("normalizes numbers and trims strings", () => {
    expect(normalizeOutboundThreadId(123.9)).toBe("123");
    expect(normalizeOutboundThreadId(" 456 ")).toBe("456");
  });

  it("drops non-finite numeric values", () => {
    expect(normalizeOutboundThreadId(Number.NaN)).toBeUndefined();
    expect(normalizeOutboundThreadId(Number.POSITIVE_INFINITY)).toBeUndefined();
  });
});
