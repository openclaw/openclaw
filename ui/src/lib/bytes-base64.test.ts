import { describe, expect, it } from "vitest";
import { bytesToBase64 } from "./bytes-base64.ts";

describe("bytesToBase64", () => {
  it.each([0, 1, 2, 256, 32_767, 32_768, 32_769, 100_000])(
    "preserves %i bytes across encoding chunks",
    (length) => {
      const bytes = Uint8Array.from({ length }, (_, index) => index % 256);
      expect(bytesToBase64(bytes)).toBe(Buffer.from(bytes).toString("base64"));
    },
  );
});
