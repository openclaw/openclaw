import type { OpenClawConfig } from "../config/config.js";

const DEFAULT_AGENT_TIMEOUT_SECONDS = 600;
const DEFAULT_SUBAGENT_ANNOUNCE_DELIVERY_TIMEOUT_MS = 60_000;
const DEFAULT_SUBAGENT_ANNOUNCE_MAX_AGE_MS = 10 * 60 * 1000;
const MAX_SAFE_TIMEOUT_MS = 2_147_000_000;

const normalizeNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : undefined;

export function resolveAgentTimeoutSeconds(cfg?: OpenClawConfig): number {
  const raw = normalizeNumber(cfg?.agents?.defaults?.timeoutSeconds);
  const seconds = raw ?? DEFAULT_AGENT_TIMEOUT_SECONDS;
  return Math.max(seconds, 1);
}

export function resolveSubagentAnnounceDeliveryTimeoutMs(cfg?: OpenClawConfig): number {
  const raw = normalizeNumber(cfg?.agents?.defaults?.subagents?.announceDeliveryTimeoutMs);
  const timeoutMs = raw ?? DEFAULT_SUBAGENT_ANNOUNCE_DELIVERY_TIMEOUT_MS;
  return Math.min(Math.max(timeoutMs, 1), MAX_SAFE_TIMEOUT_MS);
}

export function resolveSubagentAnnounceMaxAgeMs(cfg?: OpenClawConfig): number {
  const raw = normalizeNumber(cfg?.agents?.defaults?.subagents?.announceMaxAgeMs);
  if (raw === undefined || raw < 0) {
    return DEFAULT_SUBAGENT_ANNOUNCE_MAX_AGE_MS;
  }
  return Math.min(raw, MAX_SAFE_TIMEOUT_MS);
}

export function resolveAgentTimeoutMs(opts: {
  cfg?: OpenClawConfig;
  overrideMs?: number | null;
  overrideSeconds?: number | null;
  minMs?: number;
}): number {
  const minMs = Math.max(normalizeNumber(opts.minMs) ?? 1, 1);
  const clampTimeoutMs = (valueMs: number) =>
    Math.min(Math.max(valueMs, minMs), MAX_SAFE_TIMEOUT_MS);
  const defaultMs = clampTimeoutMs(resolveAgentTimeoutSeconds(opts.cfg) * 1000);
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
