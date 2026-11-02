import type { AuthProfileStore } from "../agents/auth-profiles/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type {
  MusicGenerationOutputFormat,
  MusicGenerationProviderCapabilities,
  MusicGenerationResult,
  MusicGenerationSourceImage,
} from "./types.js";

type MusicGenerationProviderConfiguredContext = {
  cfg?: OpenClawConfig;
  agentDir?: string;
};

/** Provider request after runtime fallback and override normalization. */
export type MusicGenerationRequest = {
  provider: string;
  model: string;
  prompt: string;
  cfg: OpenClawConfig;
  agentDir?: string;
  authStore?: AuthProfileStore;
  timeoutMs?: number;
  lyrics?: string;
  instrumental?: boolean;
  durationSeconds?: number;
  format?: MusicGenerationOutputFormat;
  inputImages?: MusicGenerationSourceImage[];
};

export type MusicGenerationProvider = {
  id: string;
  aliases?: string[];
  label?: string;
  defaultModel?: string;
  models?: string[];
  capabilities: MusicGenerationProviderCapabilities;
  /** @deprecated Use isConfiguredAsync so credential reads run in the database worker. Final compatibility day: 2026-12-31. Removal in the first January 2027 stable release. */
  isConfigured?: (ctx: MusicGenerationProviderConfiguredContext) => boolean;
  isConfiguredAsync?: (ctx: MusicGenerationProviderConfiguredContext) => Promise<boolean>;
  generateMusic: (req: MusicGenerationRequest) => Promise<MusicGenerationResult>;
};
