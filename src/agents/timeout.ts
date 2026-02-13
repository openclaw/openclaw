import type { OpenClawConfig } from "../config/config.js";
import { normalizeProviderId } from "./model-selection.js";

const DEFAULT_AGENT_TIMEOUT_SECONDS = 600;
const MAX_SAFE_TIMEOUT_MS = 2_147_000_000;

const normalizeNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : undefined;

/**
 * Extracts timeout value from a provider config object.
 * Prefers timeoutMs (recommended) over deprecated timeout field.
 */
function extractProviderTimeout(providerConfig: unknown): number | undefined {
  if (!providerConfig || typeof providerConfig !== "object") {
    return undefined;
  }
  const obj = providerConfig as Record<string, unknown>;

  // Prefer timeoutMs (recommended)
  if ("timeoutMs" in obj && typeof obj.timeoutMs === "number") {
    return normalizeNumber(obj.timeoutMs);
  }

  // Fallback to deprecated timeout field for backward compatibility
  if ("timeout" in obj && typeof obj.timeout === "number") {
    return normalizeNumber(obj.timeout);
  }

  return undefined;
}

export function resolveAgentTimeoutSeconds(cfg?: OpenClawConfig): number {
  const raw = normalizeNumber(cfg?.agents?.defaults?.timeoutSeconds);
  const seconds = raw ?? DEFAULT_AGENT_TIMEOUT_SECONDS;
  return Math.max(seconds, 1);
}

function resolveProviderTimeoutMs(cfg?: OpenClawConfig, provider?: string): number | undefined {
  if (!provider || !cfg?.models?.providers) {
    return undefined;
  }
  const providers = cfg.models.providers;
  const direct = providers[provider];
  const directTimeout = extractProviderTimeout(direct);
  if (directTimeout !== undefined) {
    return directTimeout;
  }
  const normalized = normalizeProviderId(provider);
  if (normalized === provider) {
    const matched = Object.entries(providers).find(
      ([key]) => normalizeProviderId(key) === normalized,
    );
    const matchedTimeout = extractProviderTimeout(matched?.[1]);
    return matchedTimeout;
  }
  const normalizedEntry = providers[normalized];
  const normalizedTimeout = extractProviderTimeout(normalizedEntry);
  return normalizedTimeout;
}

export function resolveAgentTimeoutMs(opts: {
  cfg?: OpenClawConfig;
  overrideMs?: number | null;
  overrideSeconds?: number | null;
  minMs?: number;
  provider?: string;
}): number {
  const minMs = Math.max(normalizeNumber(opts.minMs) ?? 1, 1);
  const clampTimeoutMs = (valueMs: number) =>
    Math.min(Math.max(valueMs, minMs), MAX_SAFE_TIMEOUT_MS);
  // Prefer provider-level timeoutMs over agent defaults
  const providerTimeoutMs = resolveProviderTimeoutMs(opts.cfg, opts.provider);
  const defaultMs = clampTimeoutMs(
    providerTimeoutMs ?? resolveAgentTimeoutSeconds(opts.cfg) * 1000,
  );
  // Use the maximum timer-safe timeout to represent "no timeout" when explicitly set to 0.
  const NO_TIMEOUT_MS = MAX_SAFE_TIMEOUT_MS;
  const overrideMs = normalizeNumber(opts.overrideMs);
  if (overrideMs !== undefined) {
    if (overrideMs === 0) {
      return NO_TIMEOUT_MS;
    }
    if (overrideMs < 0) {
      return defaultMs;
    }
    return clampTimeoutMs(overrideMs);
  }
  const overrideSeconds = normalizeNumber(opts.overrideSeconds);
  if (overrideSeconds !== undefined) {
    if (overrideSeconds === 0) {
      return NO_TIMEOUT_MS;
    }
    if (overrideSeconds < 0) {
      return defaultMs;
    }
    return clampTimeoutMs(overrideSeconds * 1000);
  }
  return defaultMs;
}
