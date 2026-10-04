import type { OpenClawConfig } from "../config/types.js";
import { resolveConfiguredLiveProviderModels } from "../media-generation/live-test-helpers.js";
export { resolveLiveAuthStore as resolveLiveMusicAuthStore } from "../media-generation/live-test-helpers.js";

/** Default live model refs used when a provider is enabled but not explicitly mapped. */
export const DEFAULT_LIVE_MUSIC_MODELS: Record<string, string> = {
  fal: "fal/fal-ai/minimax-music/v2.6",
  google: "google/lyria-3-clip-preview",
  minimax: "minimax/music-2.6",
  openrouter: "openrouter/google/lyria-3-pro-preview",
};

/** Resolve configured provider/model refs from the musicGenerationModel defaults. */
export function resolveConfiguredLiveMusicModels(cfg: OpenClawConfig): Map<string, string> {
  return resolveConfiguredLiveProviderModels(cfg.agents?.defaults?.mediaModels?.music);
}
