/**
 * Continuation runtime configuration resolution.
 *
 * Reads from `agents.defaults.continuation` in the gateway config.
 * Values are clamped to safe ranges. Hot-reloadable — reads happen at each
 * enforcement point, not at process start.
 *
 * RFC: docs/design/continue-work-signal-v2.md §5
 */

import { getRuntimeConfig, getRuntimeConfigSnapshot } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ContinuationRuntimeConfig } from "./types.js";

const DEFAULT_CONTINUATION_DELAY_MS = 15_000;
const DEFAULT_CONTINUATION_MIN_DELAY_MS = 5_000;
const DEFAULT_CONTINUATION_MAX_DELAY_MS = 300_000;
const DEFAULT_CONTINUATION_MAX_CHAIN_LENGTH = 10;
const DEFAULT_CONTINUATION_COST_CAP_TOKENS = 500_000;
const DEFAULT_CONTINUATION_MAX_DELEGATES_PER_TURN = 5;
const DEFAULT_EARLY_WARNING_BAND = 0.3125;

function clampPositiveInt(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.max(1, Math.trunc(value));
}

function clampNonNegativeDelayMs(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return fallback;
  }
  return Math.max(0, Math.trunc(value));
}

function clampNonNegativeInt(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return fallback;
  }
  return Math.max(0, Math.trunc(value));
}

function clampOptionalUnitInterval(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > 1) {
    return undefined;
  }
  return value;
}

function clampEarlyWarningBand(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    return DEFAULT_EARLY_WARNING_BAND;
  }
  return value;
}

/**
 * Resolve the continuation runtime config from the gateway config.
 *
 * Called at each enforcement point (scheduling, chain check, cost check, etc.)
 * so hot-reloaded config values take effect at the next decision.
 */
export function resolveContinuationRuntimeConfig(
  cfg: OpenClawConfig = getRuntimeConfig(),
): ContinuationRuntimeConfig {
  const continuation = cfg.agents?.defaults?.continuation;

  return {
    enabled: continuation?.enabled === true,
    defaultDelayMs: clampNonNegativeDelayMs(
      continuation?.defaultDelayMs,
      DEFAULT_CONTINUATION_DELAY_MS,
    ),
    minDelayMs: clampNonNegativeDelayMs(
      continuation?.minDelayMs,
      DEFAULT_CONTINUATION_MIN_DELAY_MS,
    ),
    maxDelayMs: clampNonNegativeDelayMs(
      continuation?.maxDelayMs,
      DEFAULT_CONTINUATION_MAX_DELAY_MS,
    ),
    maxChainLength: clampPositiveInt(
      continuation?.maxChainLength,
      DEFAULT_CONTINUATION_MAX_CHAIN_LENGTH,
    ),
    costCapTokens: clampNonNegativeInt(
      continuation?.costCapTokens,
      DEFAULT_CONTINUATION_COST_CAP_TOKENS,
    ),
    maxDelegatesPerTurn: clampPositiveInt(
      continuation?.maxDelegatesPerTurn,
      DEFAULT_CONTINUATION_MAX_DELEGATES_PER_TURN,
    ),
    contextPressureThreshold: clampOptionalUnitInterval(continuation?.contextPressureThreshold),
    earlyWarningBand: clampEarlyWarningBand(continuation?.earlyWarningBand),
  };
}

/**
 * Resolve continuation runtime config preferring the active runtime snapshot.
 *
 * `resolveContinuationRuntimeConfig` accepts whatever cfg the caller passes,
 * which is usually a snapshot captured at run construction. That captured
 * snapshot is stale across hot-reloads: a `gateway/reload config change applied`
 * will update the runtime snapshot but the followup-turn already holds the old
 * cfg. Using this helper at per-turn enforcement points (chain caps, cost caps,
 * pressure thresholds, schedule-time delay reads) lets reloaded values take
 * effect at the next decision-point without invalidating already-armed timers
 * or queued retries (RFC §6.5 in-flight-state invariant).
 */
export function resolveLiveContinuationRuntimeConfig(
  fallbackCfg: OpenClawConfig,
): ContinuationRuntimeConfig {
  return resolveContinuationRuntimeConfig(getRuntimeConfigSnapshot() ?? fallbackCfg);
}

/**
 * Convenience: resolve just the max delegates per turn.
 */
export function resolveMaxDelegatesPerTurn(cfg: OpenClawConfig = getRuntimeConfig()): number {
  return resolveContinuationRuntimeConfig(cfg).maxDelegatesPerTurn;
}

/**
 * Clamp a raw delay value to the configured [minDelayMs, maxDelayMs] range.
 */
export function clampDelayMs(rawMs: number | undefined, config: ContinuationRuntimeConfig): number {
  const requested = rawMs ?? config.defaultDelayMs;
  return Math.max(config.minDelayMs, Math.min(config.maxDelayMs, requested));
}
