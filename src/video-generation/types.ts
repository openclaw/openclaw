import type { MediaNormalizationEntry } from "../../packages/media-generation-core/src/normalization.js";

/** Video asset returned by a provider after generation or transformation. */
export type GeneratedVideoAsset = {
  /** Non-empty raw video bytes; may accompany url as a delivery fallback. */
  buffer?: Buffer;
  /** Provider-hosted URL returned instead of bytes or alongside them as a delivery fallback.
   * When buffer is absent, callers can forward or download without materializing the video. */
  url?: string;
  mimeType: string;
  fileName?: string;
  metadata?: Record<string, unknown>;
};

/** Resolution label accepted by video generation providers. */
export type VideoGenerationResolution =
  | "360P"
  | "480P"
  | "540P"
  | "720P"
  | "768P"
  | "1080P"
  | (string & {});

/**
 * Canonical semantic role hints for reference assets (first/last frame,
 * reference image/video/audio). Providers may accept additional role strings;
 * the asset.role type accepts both canonical values and arbitrary strings.
 */
export type VideoGenerationAssetRole =
  | "first_frame"
  | "last_frame"
  | "reference_image"
  | "reference_video"
  | "reference_audio";

/** Source media asset supplied to image/video/audio-to-video providers. */
export type VideoGenerationSourceAsset = {
  url?: string;
  buffer?: Buffer;
  mimeType?: string;
  fileName?: string;
  /**
   * Optional semantic role hint forwarded to the provider. Canonical values
   * come from `VideoGenerationAssetRole`; plain strings are accepted for
   * provider-specific extensions.
   */
  role?: VideoGenerationAssetRole | (string & {});
  metadata?: Record<string, unknown>;
};

/** Provider video generation response returned to the runtime. */
export type VideoGenerationResult = {
  videos: GeneratedVideoAsset[];
  model?: string;
  metadata?: Record<string, unknown>;
};

/** Supported high-level video generation operation modes. */
export type VideoGenerationMode = "generate" | "imageToVideo" | "videoToVideo";

/** Capability limits and supported options for one video generation mode. */
export type VideoGenerationModeCapabilities = {
  maxVideos?: number;
  maxInputImages?: number;
  maxInputImagesByModel?: Readonly<Record<string, number>>;
  maxInputVideos?: number;
  maxInputVideosByModel?: Readonly<Record<string, number>>;
  /** Max number of reference audio assets the provider accepts (e.g. background music, voice reference). */
  maxInputAudios?: number;
  maxInputAudiosByModel?: Readonly<Record<string, number>>;
  maxDurationSeconds?: number;
  supportedDurationSeconds?: readonly number[];
  supportedDurationSecondsByModel?: Readonly<Record<string, readonly number[]>>;
  sizes?: readonly string[];
  aspectRatios?: readonly string[];
  resolutions?: readonly VideoGenerationResolution[];
  supportsSize?: boolean;
  supportsAspectRatio?: boolean;
  supportsResolution?: boolean;
  supportsAudio?: boolean;
  supportsWatermark?: boolean;
  /**
   * Declared typed schema for `VideoGenerationRequest.providerOptions`. Keys
   * listed here are accepted and validated against the declared primitive
   * type before forwarding; unknown keys or type mismatches skip the
   * candidate provider at runtime so mis-typed or provider-specific options
   * never silently reach the wrong provider.
   */
  /**
   * Primitive type tag for a declared `providerOptions` key. Keep narrow —
   * plugins that need richer shapes should leave them out of the typed contract
   * and interpret the forwarded opaque value inside their own provider code.
   */
  providerOptions?: Readonly<Record<string, "number" | "boolean" | "string">>;
};

/** Capability block for transform modes that may be independently enabled. */
export type VideoGenerationTransformCapabilities = VideoGenerationModeCapabilities & {
  enabled: boolean;
};

/** Full provider capability map including base and transform mode overrides. */
export type VideoGenerationProviderCapabilities = VideoGenerationModeCapabilities & {
  generate?: VideoGenerationModeCapabilities;
  imageToVideo?: VideoGenerationTransformCapabilities;
  videoToVideo?: VideoGenerationTransformCapabilities;
};

/** Static catalog metadata that overrides provider defaults for one video model. */
export type VideoGenerationCatalogModelEntry = {
  capabilities?: VideoGenerationProviderCapabilities;
  modes?: readonly VideoGenerationMode[];
};

export type VideoGenerationIgnoredOverride = {
  key: "size" | "aspectRatio" | "resolution" | "audio" | "watermark";
  value: string | boolean;
};

export type VideoGenerationNormalization = {
  size?: MediaNormalizationEntry<string>;
  aspectRatio?: MediaNormalizationEntry<string>;
  resolution?: MediaNormalizationEntry<VideoGenerationResolution>;
  durationSeconds?: MediaNormalizationEntry<number>;
};
