export const DEFAULT_IMAGE_INPUT_PIXELS = 25_000_000;
export const MAX_CONFIGURED_IMAGE_INPUT_PIXELS = 50_000_000;

export function assertImageInputPixelLimit(value?: number): number {
  if (value === undefined) {
    return DEFAULT_IMAGE_INPUT_PIXELS;
  }
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_CONFIGURED_IMAGE_INPUT_PIXELS) {
    throw new RangeError(
      `maxInputPixels must be a positive safe integer no greater than ${MAX_CONFIGURED_IMAGE_INPUT_PIXELS.toLocaleString("en-US")}`,
    );
  }
  return value;
}
