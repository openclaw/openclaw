import { describe, expect, it } from "vitest";
import {
  truncateUtf8Prefix,
  truncateUtf8PrefixFromBuffer,
  truncateUtf8Suffix,
} from "./utf8-truncate.js";

describe("UTF-8 byte truncation", () => {
  it.each([
    { value: "abcé", maxBytes: 4, expected: "abc" },
    { value: "abc✓", maxBytes: 5, expected: "abc" },
    { value: "abc😀", maxBytes: 6, expected: "abc" },
    { value: "😀", maxBytes: 4, expected: "😀" },
  ])("keeps a valid prefix for $value at $maxBytes bytes", ({ value, maxBytes, expected }) => {
    const result = truncateUtf8Prefix(value, maxBytes);

    expect(result).toBe(expected);
    expect(Buffer.byteLength(result)).toBeLessThanOrEqual(maxBytes);
    expect(result).not.toContain("�");
  });

  it.each([
    { value: "éabc", maxBytes: 4, expected: "abc" },
    { value: "✓abc", maxBytes: 5, expected: "abc" },
    { value: "😀abc", maxBytes: 6, expected: "abc" },
    { value: "😀", maxBytes: 4, expected: "😀" },
  ])("keeps a valid suffix for $value at $maxBytes bytes", ({ value, maxBytes, expected }) => {
    const result = truncateUtf8Suffix(value, maxBytes);

    expect(result).toBe(expected);
    expect(Buffer.byteLength(result)).toBeLessThanOrEqual(maxBytes);
    expect(result).not.toContain("�");
  });

  it("returns an empty string for a non-positive limit", () => {
    expect(truncateUtf8Prefix("value", 0)).toBe("");
    expect(truncateUtf8Suffix("value", -1)).toBe("");
  });
});

describe("truncateUtf8PrefixFromBuffer", () => {
  it("decodes a buffer byte-bounded prefix without a trailing U+FFFD", () => {
    // 7 ascii + é (2 bytes) + 10 ascii; a byte cap of 8 lands between the é bytes.
    const buffer = Buffer.from(`${"x".repeat(7)}é${"y".repeat(10)}`, "utf8");
    const result = truncateUtf8PrefixFromBuffer(buffer, 8);
    expect(result).not.toContain("\uFFFD");
    expect(result).toBe("xxxxxxx");
    expect(Buffer.byteLength(result)).toBeLessThanOrEqual(8);
  });

  it("trims a dangling lead byte at the end of an already-sliced buffer", () => {
    // A buffer upstream-sliced mid-sequence ends on a lead byte (0xc3) with its
    // continuation byte cut off; decoding must not emit a trailing U+FFFD.
    const sliced = Buffer.from("xxxxxxxéyyyyyyyyyy", "utf8").subarray(0, 8);
    expect(sliced[sliced.byteLength - 1]).toBe(0xc3);
    expect(truncateUtf8PrefixFromBuffer(sliced, 8192)).toBe("xxxxxxx");
  });

  it("leaves a complete multibyte buffer unchanged when within the limit", () => {
    const value = "café 😀 中文";
    expect(truncateUtf8PrefixFromBuffer(Buffer.from(value, "utf8"), 8192)).toBe(value);
  });

  it("keeps a 4-byte emoji whole when the byte cap cuts into it", () => {
    const buffer = Buffer.from(`${"x".repeat(8189)}\uD83D\uDE00`, "utf8");
    const result = truncateUtf8PrefixFromBuffer(buffer, 8192);
    expect(result).not.toContain("\uFFFD");
    expect(Buffer.byteLength(result)).toBeLessThanOrEqual(8192);
  });

  it("returns an empty string for a non-positive limit or empty buffer", () => {
    expect(truncateUtf8PrefixFromBuffer(Buffer.from("abc", "utf8"), 0)).toBe("");
    expect(truncateUtf8PrefixFromBuffer(Buffer.alloc(0), 8192)).toBe("");
  });
});
