import type { AuthProfileStore } from "../agents/auth-profiles.js";
import type { OpenClawConfig } from "../config/config.js";

export const DEFAULT_LIVE_VIDEO_MODELS: Record<string, string> = {
  alibaba: "alibaba/wan2.6-t2v",
  byteplus: "byteplus/seedance-1-0-lite-t2v-250428",
  fal: "fal/fal-ai/minimax/video-01-live",
  google: "google/veo-3.1-fast-generate-preview",
  minimax: "minimax/MiniMax-Hailuo-2.3",
  openai: "openai/sora-2",
  qwen: "qwen/wan2.6-t2v",
  runway: "runway/gen4.5",
  together: "together/Wan-AI/Wan2.2-T2V-A14B",
  xai: "xai/grok-imagine-video",
};

const REMOTE_URL_VIDEO_TO_VIDEO_PROVIDERS = new Set(["alibaba", "qwen", "xai"]);

export function redactLiveApiKey(value: string | undefined): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    return "none";
  }
  if (trimmed.length <= 12) {
    return trimmed;
  }
  return `${trimmed.slice(0, 8)}...${trimmed.slice(-4)}`;
}

export function parseCsvFilter(raw?: string): Set<string> | null {
  const trimmed = raw?.trim();
  if (!trimmed || trimmed === "all") {
    return null;
  }
  const values = trimmed
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  return values.length > 0 ? new Set(values) : null;
}

export function parseProviderModelMap(raw?: string): Map<string, string> {
  const entries = new Map<string, string>();
  for (const token of raw?.split(",") ?? []) {
    const trimmed = token.trim();
    if (!trimmed) {
      continue;
    }
    const slash = trimmed.indexOf("/");
    if (slash <= 0 || slash === trimmed.length - 1) {
      continue;
    }
    entries.set(trimmed.slice(0, slash).trim().toLowerCase(), trimmed);
  }
  return entries;
}

export function resolveConfiguredLiveVideoModels(cfg: OpenClawConfig): Map<string, string> {
  const resolved = new Map<string, string>();
  const configured = cfg.agents?.defaults?.videoGenerationModel;
  const add = (value: string | undefined) => {
    const trimmed = value?.trim();
    if (!trimmed) {
      return;
    }
    const slash = trimmed.indexOf("/");
    if (slash <= 0 || slash === trimmed.length - 1) {
      return;
    }
    resolved.set(trimmed.slice(0, slash).trim().toLowerCase(), trimmed);
  };
  if (typeof configured === "string") {
    add(configured);
    return resolved;
  }
  add(configured?.primary);
  for (const fallback of configured?.fallbacks ?? []) {
    add(fallback);
  }
  return resolved;
}

export function canRunBufferBackedVideoToVideoLiveLane(params: {
  providerId: string;
  modelRef: string;
}): boolean {
  const providerId = params.providerId.trim().toLowerCase();
  if (REMOTE_URL_VIDEO_TO_VIDEO_PROVIDERS.has(providerId)) {
    return false;
  }
  if (providerId !== "runway") {
    return true;
  }
  const slash = params.modelRef.indexOf("/");
  const model =
    slash <= 0 || slash === params.modelRef.length - 1
      ? params.modelRef.trim()
      : params.modelRef.slice(slash + 1).trim();
  return model === "gen4_aleph";
}

export function resolveLiveVideoAuthStore(params: {
  requireProfileKeys: boolean;
  hasLiveKeys: boolean;
}): AuthProfileStore | undefined {
  if (params.requireProfileKeys || !params.hasLiveKeys) {
    return undefined;
  }
  return {
    version: 1,
    profiles: {},
  };
}
