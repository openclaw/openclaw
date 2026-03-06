import { describe, expect, it } from "vitest";
import { jsonUtf8Bytes } from "./json-utf8-bytes.js";

describe("jsonUtf8Bytes", () => {
  it("returns utf8 byte length for serializable values", () => {
    expect(jsonUtf8Bytes({ a: "x", b: [1, 2, 3] })).toBe(
      Buffer.byteLength(JSON.stringify({ a: "x", b: [1, 2, 3] }), "utf8"),
    );
  });

  it("falls back to string conversion when JSON serialization throws", () => {
    const circular: { self?: unknown } = {};
    circular.self = circular;
    expect(jsonUtf8Bytes(circular)).toBe(Buffer.byteLength("[object Object]", "utf8"));
  });
});
