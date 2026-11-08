import type { AuthProfileStore } from "../agents/auth-profiles/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type {
  VideoGenerationCatalogModelEntry,
  VideoGenerationProviderCapabilities,
  VideoGenerationResolution,
  VideoGenerationResult,
  VideoGenerationSourceAsset,
} from "./types.js";

/** Context passed when checking whether a video provider is configured. */
export type VideoGenerationProviderConfiguredContext = {
  cfg?: OpenClawConfig;
  agentDir?: string;
};

/** Context passed when resolving model-specific video generation capabilities. */
export type VideoGenerationModelCapabilitiesContext = Pick<
  VideoGenerationRequest,
  "provider" | "model" | "cfg" | "agentDir" | "authStore" | "timeoutMs"
>;

/** Normalized request object passed to a selected video generation provider. */
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
  /** Reference audio assets (e.g. background music) forwarded to the provider. */
  inputAudios?: VideoGenerationSourceAsset[];
  /** Arbitrary provider-specific parameters forwarded as-is (e.g. seed, draft, camerafixed). */
  providerOptions?: Record<string, unknown>;
};

/** Video generation provider contract implemented by provider plugins. */
export type VideoGenerationProvider = {
  id: string;
  aliases?: string[];
  label?: string;
  defaultModel?: string;
  /** Default provider operation timeout in milliseconds when caller/config omit timeoutMs. */
  defaultTimeoutMs?: number;
  models?: string[];
  capabilities: VideoGenerationProviderCapabilities;
  catalogByModel?: Readonly<Record<string, VideoGenerationCatalogModelEntry>>;
  /** @deprecated Use isConfiguredAsync so credential reads run in the database worker. Final compatibility day: 2026-12-31. Removal in the first January 2027 stable release. */
  isConfigured?: (ctx: VideoGenerationProviderConfiguredContext) => boolean;
  isConfiguredAsync?: (ctx: VideoGenerationProviderConfiguredContext) => Promise<boolean>;
  resolveModelCapabilities?: (
    ctx: VideoGenerationModelCapabilitiesContext,
  ) =>
    | VideoGenerationProviderCapabilities
    | undefined
    | Promise<VideoGenerationProviderCapabilities | undefined>;
  generateVideo: (req: VideoGenerationRequest) => Promise<VideoGenerationResult>;
};
