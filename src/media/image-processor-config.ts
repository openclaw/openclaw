import { createRastermill, type ImageExecutionMode } from "rastermill";
import { resolveSystemBin } from "../infra/resolve-system-bin.js";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";
import { DEFAULT_IMAGE_INPUT_PIXELS } from "./image-pixel-limits.js";

/** Shared input/output pixel cap for Rastermill-backed image operations. */
export const MAX_IMAGE_INPUT_PIXELS = DEFAULT_IMAGE_INPUT_PIXELS;

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
