import type { MediaNormalizationEntry } from "../../packages/media-generation-core/src/normalization.js";
import type { GeneratedImageAsset } from "./asset-types.js";

export type ImageGenerationResolution = "1K" | "2K" | "4K";

export type ImageGenerationQuality = "low" | "medium" | "high" | "xhigh" | "max" | "auto";

export type ImageGenerationOutputFormat = "png" | "jpeg" | "webp";

export type ImageGenerationBackground = "transparent" | "opaque" | "auto";

export type ImageGenerationOpenAIBackground = ImageGenerationBackground;

export type ImageGenerationOpenAIOptions = {
  background?: ImageGenerationOpenAIBackground;
  moderation?: "low" | "auto";
  outputCompression?: number;
  user?: string;
};

export type ImageGenerationProviderOptions = Record<string, unknown> & {
  openai?: ImageGenerationOpenAIOptions;
};

export type ImageGenerationIgnoredOverride = {
  key: "size" | "aspectRatio" | "resolution" | "quality" | "outputFormat" | "background";
  value: string;
};

export type ImageGenerationResult = {
  images: GeneratedImageAsset[];
  model?: string;
  metadata?: Record<string, unknown>;
};

type ImageGenerationModeCapabilities = {
  maxCount?: number;
  supportsSize?: boolean;
  supportsAspectRatio?: boolean;
  supportsResolution?: boolean;
};

export type ImageGenerationNormalization = {
  size?: MediaNormalizationEntry<string>;
  aspectRatio?: MediaNormalizationEntry<string>;
  resolution?: MediaNormalizationEntry<ImageGenerationResolution>;
};

export type ImageGenerationProviderCapabilities = {
  generate: ImageGenerationModeCapabilities;
  edit: ImageGenerationModeCapabilities & {
    enabled: boolean;
    maxInputImages?: number;
    maxInputImagesByModel?: Readonly<Record<string, number>>;
    maxInputImagesByModelPrefix?: Readonly<Record<string, number>>;
  };
  geometry?: {
    sizes?: string[];
    sizesByModel?: Record<string, string[]>;
    aspectRatios?: string[];
    aspectRatiosByModel?: Record<string, string[]>;
    resolutions?: ImageGenerationResolution[];
    resolutionsByModel?: Record<string, ImageGenerationResolution[]>;
  };
  output?: {
    qualities?: ImageGenerationQuality[];
    qualitiesByModel?: Record<string, ImageGenerationQuality[]>;
    formats?: ImageGenerationOutputFormat[];
    formatsByModel?: Record<string, ImageGenerationOutputFormat[]>;
    backgrounds?: ImageGenerationBackground[];
    backgroundsByModel?: Record<string, ImageGenerationBackground[]>;
  };
};
