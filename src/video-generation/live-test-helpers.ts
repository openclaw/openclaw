import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../config/types.js";
import { resolveConfiguredLiveProviderModels } from "../media-generation/live-test-helpers.js";
export { resolveLiveAuthStore as resolveLiveVideoAuthStore } from "../media-generation/live-test-helpers.js";

export const DEFAULT_LIVE_VIDEO_MODELS: Record<string, string> = {
  alibaba: "alibaba/wan2.6-t2v",
  byteplus: "byteplus/seedance-1-0-lite-t2v-250428",
  deepinfra: "deepinfra/Pixverse/Pixverse-T2V",
  fal: "fal/fal-ai/minimax/video-01-live",
  google: "google/veo-3.1-fast-generate-preview",
  kie: "kie/kling-2.6/text-to-video",
  minimax: "minimax/MiniMax-Hailuo-2.3",
  novita: "novita/wan2.6-t2v",
  openrouter: "openrouter/google/veo-3.1-fast",
  pixverse: "pixverse/v6",
  qwen: "qwen/wan2.6-t2v",
  runway: "runway/gen4.5",
  together: "together/Wan-AI/wan2.7-t2v",
  vydra: "vydra/veo3",
  xai: "xai/grok-imagine-video",
  zai: "zai/cogvideox-3",
};

const REMOTE_URL_VIDEO_TO_VIDEO_PROVIDERS = new Set(["alibaba", "google", "qwen", "xai"]);

type LiveVideoModel = { providerId: string; modelRef: string };

// Conservative resolutions avoid unsupported defaults and costly smoke lanes.
export function resolveLiveVideoResolution(
  params: LiveVideoModel,
): "480P" | "540P" | "720P" | "768P" | "1080P" {
  const providerId = normalizeLowercaseStringOrEmpty(params.providerId);
  if (
    providerId === "minimax" ||
    (providerId === "novita" && params.modelRef.includes("minimax-hailuo-"))
  ) {
    return "768P";
  }
  if (["novita", "openrouter", "alibaba", "qwen"].includes(providerId)) {
    return "720P";
  }
  return providerId === "pixverse" ? "540P" : "480P";
}

export function resolveConfiguredLiveVideoModels(cfg: OpenClawConfig): Map<string, string> {
  return resolveConfiguredLiveProviderModels(cfg.agents?.defaults?.mediaModels?.video);
}

export function canRunBufferBackedVideoToVideoLiveLane(params: LiveVideoModel): boolean {
  const providerId = normalizeLowercaseStringOrEmpty(params.providerId);
  // These providers require remote URL references, not buffers.
  if (REMOTE_URL_VIDEO_TO_VIDEO_PROVIDERS.has(providerId)) {
    return false;
  }
  if (providerId !== "runway") {
    return providerId !== "fal" || params.modelRef.includes("reference-to-video");
  }
  return params.modelRef.replace(/^[^/]+\//u, "").trim() === "gen4_aleph";
}

export function canRunBufferBackedImageToVideoLiveLane(params: LiveVideoModel): boolean {
  const providerId = normalizeLowercaseStringOrEmpty(params.providerId);
  if (providerId === "vydra") {
    return false;
  }
  if (providerId === "alibaba" || providerId === "qwen") {
    // The default T2V model routes a single local image to its I2V sibling.
    // Wan 2.6 R2V still requires URL-backed images in reference_urls.
    const model = params.modelRef.replace(/^[^/]+\//u, "");
    return ["wan2.6-t2v", "wan2.6-i2v", "wan2.7-r2v"].includes(model);
  }
  return providerId !== "together" || params.modelRef.includes("Wan-AI/wan2.7-i2v");
}
