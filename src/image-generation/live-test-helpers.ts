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
