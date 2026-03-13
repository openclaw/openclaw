import { describe, expect, it } from "vitest";
import { jsonUtf8Bytes } from "./json-utf8-bytes.js";

describe("jsonUtf8Bytes", () => {
  it.each([
    {
      name: "object payloads",
      value: { a: "x", b: [1, 2, 3] },
      expected: Buffer.byteLength(JSON.stringify({ a: "x", b: [1, 2, 3] }), "utf8"),
    },
    {
      name: "strings",
      value: "hello",
      expected: Buffer.byteLength(JSON.stringify("hello"), "utf8"),
    },
    {
      name: "undefined via string fallback",
      value: undefined,
      expected: Buffer.byteLength("undefined", "utf8"),
    },
  ])("returns utf8 byte length for $name", ({ value, expected }) => {
    expect(jsonUtf8Bytes(value)).toBe(expected);
  });

  it("falls back to string conversion when JSON serialization throws", () => {
    const circular: { self?: unknown } = {};
    circular.self = circular;
    expect(jsonUtf8Bytes(circular)).toBe(Buffer.byteLength("[object Object]", "utf8"));
  });

  it("uses string conversion for BigInt serialization failures", () => {
    expect(jsonUtf8Bytes(12n)).toBe(Buffer.byteLength("12", "utf8"));
  });
});
