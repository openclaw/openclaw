import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { base64ToBytes, bytesToBase64 } from "./bytes-base64.ts";

const hasNativeEncoder = typeof Uint8Array.prototype.toBase64 === "function";

describe.each(["native", "fallback"])("bytesToBase64 (%s)", (encoder) => {
  const test = it.skipIf(encoder === "native" && !hasNativeEncoder);
  test.each([0, 1, 2, 256, 32_767, 32_768, 32_769, 100_000])(
    "encodes %i bytes with standard base64 padding",
    (length) => {
      const bytes = Uint8Array.from({ length }, (_, index) => index % 256);
      if (encoder === "fallback") {
        Object.defineProperty(bytes, "toBase64", { value: undefined });
      }
      expect(bytesToBase64(bytes)).toBe(Buffer.from(bytes).toString("base64"));
    },
  );

  test("encodes only the bytes within a subarray view", () => {
    const bytes = Uint8Array.from([0xff, 0x00, 0xfb, 0xff, 0xee]);

    const view = bytes.subarray(1, 4);
    if (encoder === "fallback") {
      Object.defineProperty(view, "toBase64", { value: undefined });
    }
    expect(bytesToBase64(view)).toBe("APv/");
  });
});

const nativeDecoder = Object.getOwnPropertyDescriptor(Uint8Array, "fromBase64");
const hasNativeDecoder = typeof Uint8Array.fromBase64 === "function";

describe.each(["native", "fallback"])("base64ToBytes (%s)", (decoder) => {
  beforeEach(() => {
    if (decoder === "fallback") {
      Object.defineProperty(Uint8Array, "fromBase64", {
        configurable: true,
        writable: true,
        value: undefined,
      });
    }
  });

  afterEach(() => {
    if (decoder === "fallback") {
      if (nativeDecoder) {
        Object.defineProperty(Uint8Array, "fromBase64", nativeDecoder);
      } else {
        Reflect.deleteProperty(Uint8Array, "fromBase64");
      }
    }
  });

  const test = it.skipIf(decoder === "native" && !hasNativeDecoder);
  test.each([
    { name: "empty", input: "", bytes: [] },
    { name: "standard alphabet", input: "APv/", bytes: [0, 251, 255] },
    { name: "padded final byte", input: "Zg==", bytes: [102] },
    { name: "unpadded final byte", input: "Zg", bytes: [102] },
    { name: "unpadded final pair", input: "Zm8", bytes: [102, 111] },
    { name: "ASCII whitespace", input: " \tZ\rg\n==\f", bytes: [102] },
    { name: "unused trailing bits", input: "AB==", bytes: [0] },
  ])("decodes $name", ({ input, bytes }) => {
    expect(base64ToBytes(input)).toEqual(Uint8Array.from(bytes));
  });

  test.each(["A", "Zg=", "Zg===", "AA=A", "_w==", "Zg==\u00a0"])(
    "rejects malformed base64 %j",
    (input) => {
      expect(() => base64ToBytes(input)).toThrow();
    },
  );
});
