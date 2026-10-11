import { createHash } from "node:crypto";
import type { EncodedImage } from "rastermill";
import { logVerbose, shouldLogVerbose } from "../globals.js";
import { LruCache } from "../infra/lru-cache.js";
import { MAX_IMAGE_INPUT_PIXELS } from "./image-processor-config.js";
import { createImageProcessorWithPixelLimits } from "./image-processor.js";
import { formatMediaSize } from "./store.shared.js";

// Agent replay hydrates the same stored originals into every model request of later
// turns, and an oversized photo takes about a second to re-encode each time. The same
// bytes under the same settings encode to the same output, so content-addressed entries
// never go stale; byte-bounded LRU eviction is their only lifecycle, and 32 MiB holds
// about 60 downscaled 12 MP photos. Failures are never stored. Accepted edge cases: when
// the photos replayed together outgrow the bound, the cyclic scan misses every time and
// costs what it did before; and if one search candidate fails transiently, the smaller
// candidate the encoder settles on stays cached until eviction or restart.
const reusableEncodes = new LruCache<EncodedImage>(256, {
  maxBytes: 32 * 1024 * 1024,
  sizeOf: (encoded) => 256 + encoded.data.byteLength,
});

/** Encodes web media under `cap`, searching the given sides and qualities. */
export async function encodeWebMediaImage(params: {
  buffer: Buffer;
  cap: number;
  grid: { sides: number[]; qualities: number[] };
  maxInputPixels?: number;
  /** Reuse an earlier encode of identical bytes and settings, for repeated replay loads. */
  reuse?: boolean;
}): Promise<EncodedImage> {
  const { buffer, cap, grid } = params;
  const inputPixels = params.maxInputPixels ?? MAX_IMAGE_INPUT_PIXELS;
  const reuseKey = params.reuse
    ? `${createHash("sha256").update(buffer).digest("base64url")}:${cap}:${grid.sides.join(",")}:${grid.qualities.join(",")}:${inputPixels}`
    : undefined;
  const reused = reuseKey === undefined ? undefined : reusableEncodes.get(reuseKey);
  // Generic callers keep the shared decode limit. An owner with a bounded downscale path may
  // widen source admission explicitly, while every encoded result remains under the output cap.
  const optimized = reused
    ? copyEncodedImage(reused)
    : await createImageProcessorWithPixelLimits({
        inputPixels,
        outputPixels: MAX_IMAGE_INPUT_PIXELS,
      }).encode(buffer, {
        format: "auto",
        maxBytes: cap,
        opaque: { format: "jpeg" },
        transparent: { format: "png" },
        search: { maxSide: grid.sides, quality: grid.qualities },
        transparency: "auto",
      });
  if (optimized.chosen.transparency === "flattened" && shouldLogVerbose()) {
    logVerbose(`Image transparency flattened to fit ${formatMediaSize(cap)} optimization budget`);
  }
  logOptimizedImage(buffer.length, optimized);
  // Callers reject results over the cap, so only encodes they can return are stored.
  if (reuseKey !== undefined && !reused && optimized.data.length <= cap) {
    reusableEncodes.set(reuseKey, copyEncodedImage(optimized));
  }
  return optimized;
}

function copyEncodedImage(encoded: EncodedImage): EncodedImage {
  return { ...encoded, data: Buffer.from(encoded.data), chosen: { ...encoded.chosen } };
}

function logOptimizedImage(originalSize: number, optimized: EncodedImage): void {
  if (!shouldLogVerbose() || optimized.bytes >= originalSize) {
    return;
  }
  const resizeSide = optimized.chosen.maxSide ?? Math.max(optimized.width, optimized.height);
  if (optimized.format === "png") {
    logVerbose(
      `Optimized PNG (preserving alpha) from ${formatMediaSize(originalSize)} to ${formatMediaSize(optimized.bytes)} (side<=${resizeSide}px)`,
    );
    return;
  }
  logVerbose(
    `Optimized media from ${formatMediaSize(originalSize)} to ${formatMediaSize(optimized.bytes)} (side<=${resizeSide}px, q=${optimized.chosen.quality})`,
  );
}
