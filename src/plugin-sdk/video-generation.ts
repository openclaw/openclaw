// Public video-generation helpers and types for provider plugins.
//
// Keep these public type declarations local to the plugin-sdk entrypoint so the
// emitted declaration surface stays stable for package-boundary consumers.

import type { AuthProfileStore } from "../agents/auth-profiles.js";
import type { OpenClawConfig } from "../config/config.js";
import type {
  GeneratedVideoAsset as CoreGeneratedVideoAsset,
  VideoGenerationMode as CoreVideoGenerationMode,
  VideoGenerationModeCapabilities as CoreVideoGenerationModeCapabilities,
  VideoGenerationProvider as CoreVideoGenerationProvider,
  VideoGenerationProviderCapabilities as CoreVideoGenerationProviderCapabilities,
  VideoGenerationProviderConfiguredContext as CoreVideoGenerationProviderConfiguredContext,
  VideoGenerationRequest as CoreVideoGenerationRequest,
  VideoGenerationResolution as CoreVideoGenerationResolution,
  VideoGenerationResult as CoreVideoGenerationResult,
  VideoGenerationSourceAsset as CoreVideoGenerationSourceAsset,
  VideoGenerationTransformCapabilities as CoreVideoGenerationTransformCapabilities,
} from "../video-generation/types.js";

export type GeneratedVideoAsset = {
  buffer: Buffer;
  mimeType: string;
  fileName?: string;
  metadata?: Record<string, unknown>;
};

export type VideoGenerationResolution = "480P" | "720P" | "768P" | "1080P";

export type VideoGenerationSourceAsset = {
  url?: string;
  buffer?: Buffer;
  mimeType?: string;
  fileName?: string;
  metadata?: Record<string, unknown>;
};

export type VideoGenerationProviderConfiguredContext = {
  cfg?: OpenClawConfig;
  agentDir?: string;
};

export type VideoGenerationRequest = {
  provider: string;
  model: string;
  prompt: string;
  cfg: OpenClawConfig;
  agentDir?: string;
  authStore?: AuthProfileStore;
  timeoutMs?: number;
  size?: string;
  aspectRatio?: string;
  resolution?: VideoGenerationResolution;
  durationSeconds?: number;
  audio?: boolean;
  watermark?: boolean;
  inputImages?: VideoGenerationSourceAsset[];
  inputVideos?: VideoGenerationSourceAsset[];
};

export type VideoGenerationResult = {
  videos: GeneratedVideoAsset[];
  model?: string;
  metadata?: Record<string, unknown>;
};

export type VideoGenerationMode = "generate" | "imageToVideo" | "videoToVideo";

export type VideoGenerationModeCapabilities = {
  maxVideos?: number;
  maxInputImages?: number;
  maxInputVideos?: number;
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
};

export type VideoGenerationTransformCapabilities = VideoGenerationModeCapabilities & {
  enabled: boolean;
};

export type VideoGenerationProviderCapabilities = VideoGenerationModeCapabilities & {
  generate?: VideoGenerationModeCapabilities;
  imageToVideo?: VideoGenerationTransformCapabilities;
  videoToVideo?: VideoGenerationTransformCapabilities;
};

export type VideoGenerationProvider = {
  id: string;
  aliases?: string[];
  label?: string;
  defaultModel?: string;
  models?: string[];
  capabilities: VideoGenerationProviderCapabilities;
  isConfigured?: (ctx: VideoGenerationProviderConfiguredContext) => boolean;
  generateVideo: (req: VideoGenerationRequest) => Promise<VideoGenerationResult>;
};

type AssertAssignable<_Left extends _Right, _Right> = true;

type _VideoGenerationSdkCompat = [
  AssertAssignable<GeneratedVideoAsset, CoreGeneratedVideoAsset>,
  AssertAssignable<CoreGeneratedVideoAsset, GeneratedVideoAsset>,
  AssertAssignable<VideoGenerationMode, CoreVideoGenerationMode>,
  AssertAssignable<CoreVideoGenerationMode, VideoGenerationMode>,
  AssertAssignable<VideoGenerationModeCapabilities, CoreVideoGenerationModeCapabilities>,
  AssertAssignable<CoreVideoGenerationModeCapabilities, VideoGenerationModeCapabilities>,
  AssertAssignable<VideoGenerationProvider, CoreVideoGenerationProvider>,
  AssertAssignable<CoreVideoGenerationProvider, VideoGenerationProvider>,
  AssertAssignable<VideoGenerationProviderCapabilities, CoreVideoGenerationProviderCapabilities>,
  AssertAssignable<CoreVideoGenerationProviderCapabilities, VideoGenerationProviderCapabilities>,
  AssertAssignable<
    VideoGenerationProviderConfiguredContext,
    CoreVideoGenerationProviderConfiguredContext
  >,
  AssertAssignable<
    CoreVideoGenerationProviderConfiguredContext,
    VideoGenerationProviderConfiguredContext
  >,
  AssertAssignable<VideoGenerationRequest, CoreVideoGenerationRequest>,
  AssertAssignable<CoreVideoGenerationRequest, VideoGenerationRequest>,
  AssertAssignable<VideoGenerationResolution, CoreVideoGenerationResolution>,
  AssertAssignable<CoreVideoGenerationResolution, VideoGenerationResolution>,
  AssertAssignable<VideoGenerationResult, CoreVideoGenerationResult>,
  AssertAssignable<CoreVideoGenerationResult, VideoGenerationResult>,
  AssertAssignable<VideoGenerationSourceAsset, CoreVideoGenerationSourceAsset>,
  AssertAssignable<CoreVideoGenerationSourceAsset, VideoGenerationSourceAsset>,
  AssertAssignable<VideoGenerationTransformCapabilities, CoreVideoGenerationTransformCapabilities>,
  AssertAssignable<CoreVideoGenerationTransformCapabilities, VideoGenerationTransformCapabilities>,
];

export {
  DASHSCOPE_WAN_VIDEO_CAPABILITIES,
  DASHSCOPE_WAN_VIDEO_MODELS,
  DEFAULT_DASHSCOPE_WAN_VIDEO_MODEL,
  DEFAULT_VIDEO_GENERATION_DURATION_SECONDS,
  DEFAULT_VIDEO_GENERATION_TIMEOUT_MS,
  DEFAULT_VIDEO_RESOLUTION_TO_SIZE,
  buildDashscopeVideoGenerationInput,
  buildDashscopeVideoGenerationParameters,
  downloadDashscopeGeneratedVideos,
  extractDashscopeVideoUrls,
  pollDashscopeVideoTaskUntilComplete,
  resolveVideoGenerationReferenceUrls,
  runDashscopeVideoGenerationTask,
} from "../video-generation/dashscope-compatible.js";

export type { DashscopeVideoGenerationResponse } from "../video-generation/dashscope-compatible.js";
