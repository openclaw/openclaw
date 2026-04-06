import type { AuthProfileStore } from "../agents/auth-profiles.js";
import type { OpenClawConfig } from "../config/config.js";

export const DEFAULT_LIVE_MUSIC_MODELS: Record<string, string> = {
  google: "google/lyria-3-clip-preview",
  minimax: "minimax/music-2.5+",
};

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

export function resolveConfiguredLiveMusicModels(cfg: OpenClawConfig): Map<string, string> {
  const resolved = new Map<string, string>();
  const configured = cfg.agents?.defaults?.musicGenerationModel;
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

export function resolveLiveMusicAuthStore(params: {
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
