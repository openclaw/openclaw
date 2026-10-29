import { expect, it } from "vitest";
import { decodeUtf8Chunks, decodeUtf8Input, Utf8InputError } from "./utf8-input.js";

it("preserves valid Unicode and the BOM rather than replacement-decoding", () => {
  const text = "\uFEFFcafé 😀";
  expect(decodeUtf8Input(Buffer.from(text), "fixture")).toBe(text);
});

it.for([[0xff], [0xc3], [0xed, 0xa0, 0x80]])(
  "rejects malformed UTF-8 %j with a stable error code",
  (bytes) => {
    expect(() => decodeUtf8Input(Uint8Array.from(bytes), "fixture")).toThrow(Utf8InputError);
    try {
      decodeUtf8Input(Uint8Array.from(bytes), "fixture");
    } catch (error) {
      expect(error).toMatchObject({
        code: "ERR_INVALID_UTF8",
        message: "fixture must be valid UTF-8.",
      });
    }
  },
);

it("decodes a multibyte character split across chunks and rejects a truncated tail", async () => {
  async function* chunks(bytes: number[]) {
    for (const byte of bytes) {
      yield Uint8Array.of(byte);
    }
  }
  let text = "";
  for await (const part of decodeUtf8Chunks(chunks([...Buffer.from("😀")]), "fixture")) {
    text += part;
  }
  expect(text).toBe("😀");
  await expect(async () => {
    for await (const part of decodeUtf8Chunks(chunks([0xf0, 0x9f]), "fixture")) {
      void part;
    }
  }).rejects.toMatchObject({ code: "ERR_INVALID_UTF8" });
});
