// Tests for SQLite number normalization.
import { describe, expect, it } from "vitest";
import { normalizeSqliteNumber } from "./sqlite-number.js";

describe("normalizeSqliteNumber", () => {
  it("preserves safely representable values", () => {
    expect(normalizeSqliteNumber(42)).toBe(42);
    expect(normalizeSqliteNumber(BigInt(-1))).toBe(-1);
  });

  it.each([
    BigInt(Number.MAX_SAFE_INTEGER) + BigInt(1),
    BigInt(-Number.MAX_SAFE_INTEGER) - BigInt(1),
  ])("returns undefined for unsafe bigint %s", (value) => {
    expect(normalizeSqliteNumber(value)).toBeUndefined();
  });
});
