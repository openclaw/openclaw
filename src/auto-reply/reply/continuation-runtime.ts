import type { OpenClawConfig } from "../../config/config.js";
import { loadConfig } from "../../config/config.js";

export type ContinuationRuntimeConfig = {
  enabled: boolean;
  defaultDelayMs: number;
  minDelayMs: number;
  maxDelayMs: number;
  maxChainLength: number;
  costCapTokens: number;
  maxDelegatesPerTurn: number;
  generationGuardTolerance: number;
  contextPressureThreshold?: number;
};

const DEFAULT_CONTINUATION_DELAY_MS = 15_000;
const DEFAULT_CONTINUATION_MIN_DELAY_MS = 5_000;
const DEFAULT_CONTINUATION_MAX_DELAY_MS = 300_000;
const DEFAULT_CONTINUATION_MAX_CHAIN_LENGTH = 10;
const DEFAULT_CONTINUATION_COST_CAP_TOKENS = 500_000;
const DEFAULT_CONTINUATION_MAX_DELEGATES_PER_TURN = 5;
const DEFAULT_CONTINUATION_GENERATION_GUARD_TOLERANCE = 0;

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
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    return undefined;
  }
  return value;
}

export function resolveContinuationRuntimeConfig(
  cfg: OpenClawConfig = loadConfig(),
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
    generationGuardTolerance: clampNonNegativeInt(
      continuation?.generationGuardTolerance,
      DEFAULT_CONTINUATION_GENERATION_GUARD_TOLERANCE,
    ),
    contextPressureThreshold: clampOptionalUnitInterval(continuation?.contextPressureThreshold),
  };
}

export function resolveMaxDelegatesPerTurn(cfg: OpenClawConfig = loadConfig()): number {
  return resolveContinuationRuntimeConfig(cfg).maxDelegatesPerTurn;
}
