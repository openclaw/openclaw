import { describe, expect, it } from "vitest";
import { parseNonNegativeByteSize } from "./byte-size.js";

describe("parseNonNegativeByteSize", () => {
  it.each([
    [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
    [String(Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER],
    ["2mb", 2097152],
    ["1m", 1048576],
    ["1KiB", 1024],
    ["1.5MiB", 1572864],
    ["2GiB", 2147483648],
    ["1TiB", 1099511627776],
  ])("parses %j as %i bytes", (value, expected) => {
    expect(parseNonNegativeByteSize(value)).toBe(expected);
  });

  it.each([Number.MAX_SAFE_INTEGER + 1, "9007199254740993", "8192TiB"])(
    "rejects unsafe byte size %j",
    (value) => expect(parseNonNegativeByteSize(value)).toBeNull(),
  );
});
