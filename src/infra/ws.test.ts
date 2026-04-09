import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import { rawDataByteLength, rawDataToString } from "./ws.js";

describe("rawDataToString", () => {
  it("returns string input unchanged", () => {
    expect(rawDataToString("hello" as unknown as Parameters<typeof rawDataToString>[0])).toBe(
      "hello",
    );
  });

  it("decodes Buffer, Buffer[] and ArrayBuffer inputs", () => {
    expect(rawDataToString(Buffer.from("hello"))).toBe("hello");
    expect(rawDataToString([Buffer.from("he"), Buffer.from("llo")])).toBe("hello");
    expect(rawDataToString(Uint8Array.from([104, 101, 108, 108, 111]).buffer)).toBe("hello");
  });

  it("decodes typed-array views using the underlying bytes", () => {
    expect(rawDataToString(Uint8Array.from([104, 101, 108, 108, 111]) as never)).toBe("hello");
    expect(rawDataToString(new DataView(Uint8Array.from([111, 107]).buffer) as never)).toBe("ok");
  });

  it("falls back to string coercion for other unsupported raw data shapes", () => {
    expect(rawDataToString({ hello: "world" } as never)).toBe("[object Object]");
  });
});

describe("rawDataByteLength", () => {
  it("counts strings, buffers, arrays, and binary views by byte length", () => {
    expect(rawDataByteLength("hello" as unknown as Parameters<typeof rawDataByteLength>[0])).toBe(
      5,
    );
    expect(rawDataByteLength(Buffer.from("hello"))).toBe(5);
    expect(rawDataByteLength([Buffer.from("he"), Buffer.from("llo")])).toBe(5);
    expect(rawDataByteLength(Uint8Array.from([104, 101, 108, 108, 111]).buffer)).toBe(5);
    expect(rawDataByteLength(Uint8Array.from([1, 2, 3]) as never)).toBe(3);
    expect(rawDataByteLength(new DataView(Uint8Array.from([4, 5]).buffer) as never)).toBe(2);
  });

  it("falls back to string coercion for unsupported raw data shapes", () => {
    expect(rawDataByteLength({ ok: true } as never)).toBe("[object Object]".length);
  });
});
