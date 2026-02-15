import type { OpenClawConfig } from "./types.js";

export const DEFAULT_AGENT_MAX_CONCURRENT = 4;
export const DEFAULT_SUBAGENT_MAX_CONCURRENT = 8;

export const DEFAULT_SUBAGENT_PROVIDER_LIMITS = Object.freeze({
  google: 3,
  zai: 3,
  openai: 8,
  anthropic: 20,
  unknown: 3,
} as const);

export function normalizeSubagentProviderLimitKey(provider?: string): string | undefined {
  if (typeof provider !== "string") {
    return undefined;
  }
  const normalized = provider
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
  return normalized || undefined;
}

export function resolveAgentMaxConcurrent(cfg?: OpenClawConfig): number {
  const raw = cfg?.agents?.defaults?.maxConcurrent;
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return Math.max(1, Math.floor(raw));
  }
  return DEFAULT_AGENT_MAX_CONCURRENT;
}

export function resolveSubagentMaxConcurrent(cfg?: OpenClawConfig): number {
  const raw = cfg?.agents?.defaults?.subagents?.maxConcurrent;
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return Math.max(1, Math.floor(raw));
  }
  return DEFAULT_SUBAGENT_MAX_CONCURRENT;
}

export function resolveSubagentProviderLimits(cfg?: OpenClawConfig): Record<string, number> {
  const limits: Record<string, number> = {
    ...DEFAULT_SUBAGENT_PROVIDER_LIMITS,
  };
  const rawLimits = cfg?.agents?.defaults?.subagents?.providerLimits;
  if (!rawLimits || typeof rawLimits !== "object") {
    return limits;
  }

  for (const [providerRaw, limitRaw] of Object.entries(rawLimits)) {
    const provider = normalizeSubagentProviderLimitKey(providerRaw);
    if (!provider || typeof limitRaw !== "number" || !Number.isFinite(limitRaw)) {
      continue;
    }
    limits[provider] = Math.max(1, Math.floor(limitRaw));
  }

  return limits;
}

export function resolveSubagentProviderLimit(cfg: OpenClawConfig | undefined, provider?: string) {
  const limits = resolveSubagentProviderLimits(cfg);
  const providerKey = normalizeSubagentProviderLimitKey(provider);
  if (providerKey && typeof limits[providerKey] === "number") {
    return limits[providerKey];
  }
  return limits.unknown;
}
