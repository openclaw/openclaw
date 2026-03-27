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
    {
      name: "unicode strings",
      value: "🙂",
      expected: Buffer.byteLength(JSON.stringify("🙂"), "utf8"),
    },
  ])("returns utf8 byte length for $name", ({ value, expected }) => {
    expect(jsonUtf8Bytes(value)).toBe(expected);
  });

  it("falls back to string conversion when JSON serialization throws", () => {
    const circular: { self?: unknown } = {};
    circular.self = circular;
    expect(jsonUtf8Bytes(circular)).toBe(Buffer.byteLength("[object Object]", "utf8"));
  });

  it.each([
    { name: "BigInt serialization failures", value: 12n, expected: "12" },
    { name: "symbol serialization failures", value: Symbol("token"), expected: "Symbol(token)" },
  ])("uses string conversion for $name", ({ value, expected }) => {
    expect(jsonUtf8Bytes(value)).toBe(Buffer.byteLength(expected, "utf8"));
  });
});
