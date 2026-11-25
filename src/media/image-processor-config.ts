import { createRastermill, type ImageExecutionMode } from "rastermill";
import { resolveSystemBin } from "../infra/resolve-system-bin.js";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";

/** Shared input/output pixel cap for Rastermill-backed image operations. */
export const MAX_IMAGE_INPUT_PIXELS = 25_000_000;

/**
 * Source admission for owners whose output is a bounded downscale under MAX_IMAGE_INPUT_PIXELS.
 * Covers tall full-page screenshots and 48 MP phone photos; a 64 MP decode peaks near 0.8 GB in
 * the image worker, against roughly 0.5 GB at the shared cap.
 */
export const MAX_IMAGE_DOWNSCALE_SOURCE_PIXELS = 64_000_000;

export type ImageProcessorPixelLimits = { inputPixels: number; outputPixels: number };

export function createLocalImageProcessor(
  execution: ImageExecutionMode,
  limits: ImageProcessorPixelLimits = {
    inputPixels: MAX_IMAGE_INPUT_PIXELS,
    outputPixels: MAX_IMAGE_INPUT_PIXELS,
  },
) {
  return createRastermill({
    execution,
    limits,
    temp: {
      rootDir: resolvePreferredOpenClawTmpDir(),
      prefix: "openclaw-img-",
    },
    commandResolver: (command) =>
      resolveSystemBin(command, { trust: command === "powershell" ? "strict" : "standard" }),
  });
}
