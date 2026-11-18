import { describe, expect, it } from "vitest";
import { createSolidPngBuffer } from "../../test/helpers/image-fixtures.js";
import { ImageOptimizationLimitError } from "../media/image-optimization-error.js";
import { readImageMetadataFromHeader } from "../media/media-services.js";
import { optimizeImageDescriptionInput } from "./image-input-normalize.js";

describe("image description input optimization", () => {
  it("downscales recognized images to the selected model policy", async () => {
    const result = await optimizeImageDescriptionInput({
      buffer: createSolidPngBuffer(64, 48, { r: 24, g: 96, b: 208 }),
      fileName: "phone.png",
      mime: "image/png",
      modelPolicy: { maxSidePx: 32, preferredSidePx: 32 },
      maxBytes: 1024 * 1024,
    });

    expect(result.mime).toBe("image/jpeg");
    expect(result.fileName).toBe("phone.jpg");
    expect(result.buffer).not.toEqual(createSolidPngBuffer(64, 48, { r: 24, g: 96, b: 208 }));
    expect(readImageMetadataFromHeader(result.buffer)).toEqual({ width: 32, height: 24 });
  });

  it("preserves provider-owned unknown formats while enforcing the effective byte cap", async () => {
    const buffer = Buffer.from("custom-provider-image");
    await expect(
      optimizeImageDescriptionInput({
        buffer,
        mime: "image/x-custom",
        modelPolicy: { maxSidePx: 32, preferredSidePx: 32 },
        maxBytes: buffer.length,
      }),
    ).resolves.toEqual({ buffer, fileName: undefined, mime: "image/x-custom" });

    await expect(
      optimizeImageDescriptionInput({
        buffer,
        mime: "image/x-custom",
        modelPolicy: { maxBytes: buffer.length - 1 },
        maxBytes: buffer.length,
      }),
    ).rejects.toMatchObject({
      name: ImageOptimizationLimitError.name,
      maxBytes: buffer.length - 1,
    });
  });
});
