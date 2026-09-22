import { describe, expect, it } from "vitest";
import { createImageProcessor, createImageProcessorWithPixelLimits } from "./image-processor.js";

const image = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEUlEQVR4nGMwSJiAFTEMLQkACmxIAasRElQAAAAASUVORK5CYII=",
  "base64",
);

describe("operation-specific pixel limits through the image worker", () => {
  it("keeps local probes, worker encodes and later default requests consistent", async () => {
    const restricted = createImageProcessorWithPixelLimits({ inputPixels: 32, outputPixels: 16 });
    expect(await restricted.probe(image)).toBeNull();
    await expect(
      restricted.encode(image, { format: "png", resize: { maxSide: 4 } }),
    ).rejects.toThrow();

    const downscale = createImageProcessorWithPixelLimits({ inputPixels: 64, outputPixels: 16 });
    expect(await downscale.probe(image)).toMatchObject({ width: 8, height: 8 });
    const encoded = await downscale.encode(image, { format: "png", resize: { maxSide: 4 } });
    expect(encoded).toMatchObject({ width: 4, height: 4, format: "png" });
    expect(encoded.data.length).toBeGreaterThan(0);
    await expect(downscale.encode(image, { format: "png" })).rejects.toMatchObject({
      code: "RASTERMILL_OUTPUT_TOO_LARGE",
    });

    // A scoped downscale limit must not change the shared worker's subsequent default policy.
    const normal = await createImageProcessor().encode(image, { format: "png" });
    expect(normal).toMatchObject({ width: 8, height: 8, format: "png" });
  });
});
