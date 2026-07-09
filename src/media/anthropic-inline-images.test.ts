import { describe, expect, it } from "vitest";
import { createSolidPngBuffer } from "../../test/helpers/image-fixtures.js";
import { normalizeImageForAnthropic } from "./anthropic-inline-images.js";

describe("normalizeImageForAnthropic", () => {
  it("passes through supported Anthropic image MIME types", async () => {
    const png = await createSolidPngBuffer(8, 8, { r: 0x10, g: 0x20, b: 0x30 });
    const normalized = await normalizeImageForAnthropic({
      data: png.toString("base64"),
      mimeType: "image/png",
    });

    expect(normalized).toEqual({
      data: png.toString("base64"),
      mimeType: "image/png",
    });
  });

  it("transcodes unsupported image MIME types to an Anthropic-supported format", async () => {
    const png = await createSolidPngBuffer(8, 8, { r: 0x40, g: 0x80, b: 0xc0 });
    const normalized = await normalizeImageForAnthropic({
      data: png.toString("base64"),
      mimeType: "image/tiff",
    });

    expect(normalized.mimeType).toBe("image/jpeg");
    expect(normalized.data).not.toBe(png.toString("base64"));
  });
});
