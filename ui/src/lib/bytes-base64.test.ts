import { describe, expect, it } from "vitest";
import { bytesToBase64 } from "./bytes-base64.ts";

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

    expect(bytesToBase64(bytes.subarray(1, 4))).toBe("APv/");
  });
});
