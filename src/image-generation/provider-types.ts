import type { AuthProfileStore } from "../agents/auth-profiles/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { SsrFPolicy } from "../infra/net/ssrf.js";
import type { ImageGenerationSourceImage } from "./asset-types.js";
import type {
  ImageGenerationBackground,
  ImageGenerationOutputFormat,
  ImageGenerationProviderCapabilities,
  ImageGenerationProviderOptions,
  ImageGenerationQuality,
  ImageGenerationResolution,
  ImageGenerationResult,
} from "./types.js";

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
