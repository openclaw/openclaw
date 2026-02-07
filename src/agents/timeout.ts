import type { OpenClawConfig } from "../config/config.js";

const DEFAULT_AGENT_TIMEOUT_SECONDS = 600;
// Maximum safe value for setTimeout (32-bit signed integer max, ~24.8 days).
// Values larger than this cause Node.js TimeoutOverflowWarning.
const MAX_SAFE_TIMEOUT_MS = 2_147_483_647;

const normalizeNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : undefined;

export function resolveAgentTimeoutSeconds(cfg?: OpenClawConfig): number {
  const raw = normalizeNumber(cfg?.agents?.defaults?.timeoutSeconds);
  const seconds = raw ?? DEFAULT_AGENT_TIMEOUT_SECONDS;
  return Math.max(seconds, 1);
}

export function resolveAgentTimeoutMs(opts: {
  cfg?: OpenClawConfig;
  overrideMs?: number | null;
  overrideSeconds?: number | null;
  minMs?: number;
}): number {
  const minMs = Math.max(normalizeNumber(opts.minMs) ?? 1, 1);
  const defaultMs = resolveAgentTimeoutSeconds(opts.cfg) * 1000;
  // Use the maximum safe setTimeout value (~24.8 days) to represent "no timeout"
  // when explicitly set to 0. This avoids TimeoutOverflowWarning from Node.js
  // which occurs when the value exceeds 32-bit signed integer max (2147483647).
  const NO_TIMEOUT_MS = MAX_SAFE_TIMEOUT_MS;
  const overrideMs = normalizeNumber(opts.overrideMs);
  if (overrideMs !== undefined) {
    if (overrideMs === 0) {
      return NO_TIMEOUT_MS;
    }
    if (overrideMs < 0) {
      return clampTimeout(defaultMs);
    }
    return clampTimeout(Math.max(overrideMs, minMs));
  }
  const overrideSeconds = normalizeNumber(opts.overrideSeconds);
  if (overrideSeconds !== undefined) {
    if (overrideSeconds === 0) {
      return NO_TIMEOUT_MS;
    }
    if (overrideSeconds < 0) {
      return clampTimeout(defaultMs);
    }
    return clampTimeout(Math.max(overrideSeconds * 1000, minMs));
  }
  return clampTimeout(Math.max(defaultMs, minMs));
}

/** Clamp timeout to maximum safe value for setTimeout (32-bit signed int). */
function clampTimeout(ms: number): number {
  return Math.min(ms, MAX_SAFE_TIMEOUT_MS);
}
