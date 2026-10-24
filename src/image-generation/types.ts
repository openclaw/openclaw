import type { MediaNormalizationEntry } from "../../packages/media-generation-core/src/normalization.js";
import type { AuthProfileStore } from "../agents/auth-profiles/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { SsrFPolicy } from "../infra/net/ssrf.js";

/** Non-empty binary image asset returned by an image-generation provider. */
export type GeneratedImageAsset = {
  buffer: Buffer;
  mimeType: string;
  fileName?: string;
  revisedPrompt?: string;
  metadata?: Record<string, unknown>;
};

export type ImageGenerationResolution = "1K" | "2K" | "4K";

type ImageGenerationQuality = "low" | "medium" | "high" | "xhigh" | "max" | "auto";

export type ImageGenerationOutputFormat = "png" | "jpeg" | "webp";

type ImageGenerationBackground = "transparent" | "opaque" | "auto";

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

export type ImageGenerationSourceImage = Omit<GeneratedImageAsset, "revisedPrompt">;

export type ImageGenerationProviderConfiguredContext = {
  cfg?: OpenClawConfig;
  agentDir?: string;
};

/** Runtime request passed to an image-generation provider implementation. */
export type ImageGenerationRequest = {
  provider: string;
  model: string;
  prompt: string;
  cfg: OpenClawConfig;
  agentDir?: string;
  authStore?: AuthProfileStore;
  timeoutMs?: number;
  /** Cancels image generation and any result downloads owned by this request. */
  signal?: AbortSignal;
  count?: number;
  size?: string;
  aspectRatio?: string;
  resolution?: ImageGenerationResolution;
  quality?: ImageGenerationQuality;
  outputFormat?: ImageGenerationOutputFormat;
  background?: ImageGenerationBackground;
  inputImages?: ImageGenerationSourceImage[];
  providerOptions?: ImageGenerationProviderOptions;
  ssrfPolicy?: SsrFPolicy;
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

export type ImageGenerationProvider = {
  id: string;
  aliases?: string[];
  label?: string;
  defaultModel?: string;
  /** Default provider operation timeout in milliseconds when caller/config omit timeoutMs. */
  defaultTimeoutMs?: number;
  models?: string[];
  capabilities: ImageGenerationProviderCapabilities;
  /** @deprecated Use isConfiguredAsync so credential reads run in the database worker. Final compatibility day: 2026-12-31. Removal in the first January 2027 stable release. */
  isConfigured?: (ctx: ImageGenerationProviderConfiguredContext) => boolean;
  isConfiguredAsync?: (ctx: ImageGenerationProviderConfiguredContext) => Promise<boolean>;
  generateImage: (req: ImageGenerationRequest) => Promise<ImageGenerationResult>;
};
