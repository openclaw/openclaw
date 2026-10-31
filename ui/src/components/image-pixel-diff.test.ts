import { describe, expect, it } from "vitest";
import { compareImagePixels, type ImagePixels } from "./image-pixel-diff.ts";
const pixels = (data: number[], width = 2, height = 1): ImagePixels => ({
  width,
  height,
  data: new Uint8ClampedArray(data),
});
describe("exact decoded image comparison", () => {
  it("reports equality and a transparent difference mask", () => {
    const image = pixels([20, 30, 40, 255, 80, 90, 100, 255]);
    const result = compareImagePixels(image, pixels([...image.data]));
    expect(result?.changedPixels).toBe(0);
    expect(result?.totalPixels).toBe(2);
    expect([...result!.data]).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
  });
  it("counts each changed pixel once and paints an opaque magenta mask", () => {
    const result = compareImagePixels(
      pixels([0, 0, 0, 255, 80, 90, 100, 255]),
      pixels([255, 255, 255, 255, 80, 90, 100, 255]),
    );
    expect(result?.changedPixels).toBe(1);
    expect([...result!.data]).toEqual([255, 0, 255, 255, 0, 0, 0, 0]);
  });
  it("includes alpha differences", () => {
    const result = compareImagePixels(
      pixels([20, 30, 40, 255, 80, 90, 100, 255]),
      pixels([20, 30, 40, 254, 80, 90, 100, 255]),
    );
    expect(result?.changedPixels).toBe(1);
  });
  it("rejects different shapes even when the pixel counts match", () => {
    expect(
      compareImagePixels(pixels([0, 0, 0, 0, 0, 0, 0, 0]), pixels([0, 0, 0, 0, 0, 0, 0, 0], 1, 2)),
    ).toBeNull();
  });
});
