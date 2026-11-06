import { describe, expect, it } from "vitest";
import { base64ToBytes, bytesToBase64 } from "./bytes-base64.ts";

describe("bytesToBase64", () => {
  it.each([0, 1, 2, 256, 32_767, 32_768, 32_769, 100_000])(
    "encodes %i bytes with standard base64 padding",
    (length) => {
      const bytes = Uint8Array.from({ length }, (_, index) => index % 256);
      expect(bytesToBase64(bytes)).toBe(Buffer.from(bytes).toString("base64"));
    },
  );

  it("encodes only the bytes within a subarray view", () => {
    const bytes = Uint8Array.from([0xff, 0x00, 0xfb, 0xff, 0xee]);

    const view = bytes.subarray(1, 4);
    expect(bytesToBase64(view)).toBe("APv/");
  });
});

describe("base64ToBytes", () => {
  it.each([
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

  it.each(["A", "Zg=", "Zg===", "AA=A", "_w==", "Zg==\u00a0"])(
    "rejects malformed base64 %j",
    (input) => {
      expect(() => base64ToBytes(input)).toThrow();
    },
  );
});
