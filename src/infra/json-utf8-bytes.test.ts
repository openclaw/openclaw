import { describe, expect, it } from "vitest";
import { jsonUtf8Bytes } from "./json-utf8-bytes.js";

function createCircularValue() {
  const circular: { self?: unknown } = {};
  circular.self = circular;
  return circular;
}

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

  it.each([
    {
      name: "circular serialization failures",
      value: createCircularValue(),
      expected: "[object Object]",
    },
    { name: "BigInt serialization failures", value: 12n, expected: "12" },
    { name: "symbol serialization failures", value: Symbol("token"), expected: "Symbol(token)" },
  ])("uses string conversion for $name", ({ value, expected }) => {
    expect(jsonUtf8Bytes(value)).toBe(Buffer.byteLength(expected, "utf8"));
  });
});
