import { ToolInputError } from "../agents/tool-input-error.js";
import type { ImageGenerationResolution } from "./types.js";

export function normalizeImageGenerationResolution(
  raw: string | undefined,
): ImageGenerationResolution | undefined {
  const normalized = raw?.trim().toUpperCase();
  if (!normalized) {
    return undefined;
  }
  if (normalized === "1K" || normalized === "2K" || normalized === "4K") {
    return normalized;
  }
  throw new ToolInputError("resolution must be one of 1K, 2K, or 4K");
}
