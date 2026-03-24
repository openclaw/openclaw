import type { AuthProfileStore } from "../agents/auth-profiles.js";
import type { OpenClawConfig } from "../config/config.js";

export type GeneratedVideoAsset = {
  buffer: Buffer;
  mimeType: string;
  fileName?: string;
  durationSeconds?: number;
  metadata?: Record<string, unknown>;
};

export type VideoGenerationSourceImage = {
  url?: string;
  buffer?: Buffer;
  mimeType?: string;
  role: "first_frame" | "last_frame";
};

export type VideoGenerationRequest = {
  provider: string;
  model: string;
  prompt: string;
  cfg: OpenClawConfig;
  agentDir?: string;
  authStore?: AuthProfileStore;
  timeoutMs?: number;
  durationSeconds?: number;
  aspectRatio?: string;
  resolution?: string;
  seed?: number;
  watermark?: boolean;
  firstFrameImage?: VideoGenerationSourceImage;
  lastFrameImage?: VideoGenerationSourceImage;
  /** Provider-specific options (e.g. camerafixed, draft). */
  providerOptions?: Record<string, unknown>;
};

export type VideoGenerationResult = {
  videos: GeneratedVideoAsset[];
  model?: string;
  metadata?: Record<string, unknown>;
};

export type VideoGenerationProviderCapabilities = {
  supportsDuration?: boolean;
  supportsAspectRatio?: boolean;
  supportsResolution?: boolean;
  maxDurationSeconds?: number;
  minDurationSeconds?: number;
  aspectRatios?: string[];
  resolutions?: string[];
};

export type VideoGenerationProvider = {
  id: string;
  aliases?: string[];
  label?: string;
  defaultModel?: string;
  models?: string[];
  capabilities: VideoGenerationProviderCapabilities;
  generateVideo: (req: VideoGenerationRequest) => Promise<VideoGenerationResult>;
};
