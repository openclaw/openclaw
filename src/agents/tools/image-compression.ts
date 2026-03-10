import type { ImageCompressionConfig } from "../../config/types.agent-defaults.js";

/**
 * Resolved image compression settings used by the image tool.
 */
export type ResolvedImageCompressionSettings = {
  /** Whether to apply compression/optimization */
  optimize: boolean;
  /** Maximum side length in pixels (applied to both width and height) */
  maxSide?: number;
  /** JPEG quality (1-100) */
  quality?: number;
};

/**
 * Preset compression settings.
 */
export const IMAGE_COMPRESSION_PRESETS: Record<
  "none" | "low" | "medium" | "high",
  ResolvedImageCompressionSettings
> = {
  none: { optimize: false },
  low: { optimize: true, maxSide: 800, quality: 50 },
  medium: { optimize: true, maxSide: 1200, quality: 70 },
  high: { optimize: true, maxSide: 2000, quality: 95 },
};

const DEFAULT_DETAIL_SETTINGS = {
  maxSide: 2000,
  quality: 95,
};

/**
 * Resolves image compression config to concrete settings.
 * Falls back to "medium" preset when no config is provided.
 */
export function resolveImageCompressionSettings(params: {
  compression?: ImageCompressionConfig;
}): ResolvedImageCompressionSettings {
  const { compression } = params;

  // No config: use medium preset (balanced default)
  if (compression === undefined) {
    return IMAGE_COMPRESSION_PRESETS.medium;
  }

  // String preset
  if (typeof compression === "string") {
    return IMAGE_COMPRESSION_PRESETS[compression];
  }

  // Detailed config
  const maxWidth = compression.maxWidth ?? DEFAULT_DETAIL_SETTINGS.maxSide;
  const maxHeight = compression.maxHeight ?? DEFAULT_DETAIL_SETTINGS.maxSide;
  const quality = compression.quality ?? DEFAULT_DETAIL_SETTINGS.quality;
  const maxSide = Math.min(maxWidth, maxHeight);

  return {
    optimize: true,
    maxSide,
    quality,
  };
}
