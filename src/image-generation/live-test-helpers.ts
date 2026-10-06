import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  parseLiveCsvFilter,
  parseProviderModelMap,
  resolveConfiguredLiveProviderModels,
} from "../media-generation/live-test-helpers.js";

export { parseProviderModelMap };
export { resolveLiveAuthStore as resolveLiveImageAuthStore } from "../media-generation/live-test-helpers.js";

// Default provider/model matrix for image live tests. Provider env filters can
// override these without changing test source.
export const DEFAULT_LIVE_IMAGE_MODELS: Partial<Record<string, string>> = {
  deepinfra: "deepinfra/black-forest-labs/FLUX-1-schnell",
  fal: "fal/fal-ai/flux/dev",
  google: "google/gemini-3.1-flash-image-preview",
  minimax: "minimax/image-01",
  openai: "openai/gpt-image-2",
  openrouter: "openrouter/google/gemini-3.1-flash-image-preview",
  vydra: "vydra/grok-imagine",
  xai: "xai/grok-imagine-image",
};

// Case filters are intentionally lowercased because test case names are local
// labels, unlike provider ids/models that may be case-sensitive.
export function parseCaseFilter(raw?: string): Set<string> | null {
  return parseLiveCsvFilter(raw);
}

export function parseImageProviderFilter(raw?: string): Set<string> | null {
  return parseLiveCsvFilter(raw, { lowercase: false });
}

export function resolveConfiguredLiveImageModels(cfg: OpenClawConfig): Map<string, string> {
  return resolveConfiguredLiveProviderModels(cfg.agents?.defaults?.mediaModels?.image);
}
