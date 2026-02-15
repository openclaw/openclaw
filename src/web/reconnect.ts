import { randomUUID } from "node:crypto";
import type { OpenClawConfig } from "../config/config.js";
import type { BackoffPolicy } from "../infra/backoff.js";
import { computeBackoff, sleepWithAbort } from "../infra/backoff.js";
import { clamp } from "../utils.js";

export type ReconnectPolicy = BackoffPolicy & {
  maxAttempts: number;
};

/**
 * Three-tier graduated retry strategy for resilient connection handling.
 *
 * Tier 1 (Fast): Quick retries for brief network blips (2s-30s)
 * Tier 2 (Medium): Moderate backoff for extended outages (30s-5min)
 * Tier 3 (Slow): Patient retries for prolonged issues (5-15min, unlimited)
 */
export type TieredReconnectPolicy = {
  tier1: ReconnectPolicy; // Fast: brief blips
  tier2: ReconnectPolicy; // Medium: extended outages
  tier3: ReconnectPolicy; // Slow: prolonged issues (unlimited)
};

export const DEFAULT_HEARTBEAT_SECONDS = 60;

// Tier 1: Fast retries for brief network blips
export const DEFAULT_TIER1_POLICY: ReconnectPolicy = {
  initialMs: 2_000,
  maxMs: 30_000,
  factor: 1.8,
  jitter: 0.25,
  maxAttempts: 12,
};

// Tier 2: Medium backoff for extended outages
export const DEFAULT_TIER2_POLICY: ReconnectPolicy = {
  initialMs: 30_000,
  maxMs: 300_000, // 5 minutes
  factor: 1.5,
  jitter: 0.2,
  maxAttempts: 10,
};

// Tier 3: Patient retries for prolonged issues (unlimited attempts)
export const DEFAULT_TIER3_POLICY: ReconnectPolicy = {
  initialMs: 300_000, // 5 minutes
  maxMs: 900_000, // 15 minutes
  factor: 1.2,
  jitter: 0.15,
  maxAttempts: 0, // 0 = unlimited
};

// Legacy default for backward compatibility
export const DEFAULT_RECONNECT_POLICY: ReconnectPolicy = DEFAULT_TIER1_POLICY;

export const DEFAULT_TIERED_POLICY: TieredReconnectPolicy = {
  tier1: DEFAULT_TIER1_POLICY,
  tier2: DEFAULT_TIER2_POLICY,
  tier3: DEFAULT_TIER3_POLICY,
};

export function resolveHeartbeatSeconds(cfg: OpenClawConfig, overrideSeconds?: number): number {
  const candidate = overrideSeconds ?? cfg.web?.heartbeatSeconds;
  if (typeof candidate === "number" && candidate > 0) {
    return candidate;
  }
  return DEFAULT_HEARTBEAT_SECONDS;
}

export function resolveReconnectPolicy(
  cfg: OpenClawConfig,
  overrides?: Partial<ReconnectPolicy>,
): ReconnectPolicy {
  const reconnectOverrides = cfg.web?.reconnect ?? {};
  const overrideConfig = overrides ?? {};
  const merged = {
    ...DEFAULT_RECONNECT_POLICY,
    ...reconnectOverrides,
    ...overrideConfig,
  } as ReconnectPolicy;

  merged.initialMs = Math.max(250, merged.initialMs);
  merged.maxMs = Math.max(merged.initialMs, merged.maxMs);
  merged.factor = clamp(merged.factor, 1.1, 10);
  merged.jitter = clamp(merged.jitter, 0, 1);
  merged.maxAttempts = Math.max(0, Math.floor(merged.maxAttempts));
  return merged;
}

/**
 * Resolve tiered reconnect policy from config with optional overrides.
 */
export function resolveTieredPolicy(
  cfg: OpenClawConfig,
  overrides?: Partial<TieredReconnectPolicy>,
): TieredReconnectPolicy {
  const cfgTiers = (cfg.web as { tieredReconnect?: Partial<TieredReconnectPolicy> })
    ?.tieredReconnect;
  const legacyReconnect = cfg.web?.reconnect;

  // Map legacy reconnect config to tier1 if tieredReconnect not configured
  const tier1Base = cfgTiers?.tier1 ?? (cfgTiers ? undefined : legacyReconnect);

  return {
    tier1: normalizePolicy({ ...DEFAULT_TIER1_POLICY, ...tier1Base, ...overrides?.tier1 }),
    tier2: normalizePolicy({ ...DEFAULT_TIER2_POLICY, ...cfgTiers?.tier2, ...overrides?.tier2 }),
    tier3: normalizePolicy({ ...DEFAULT_TIER3_POLICY, ...cfgTiers?.tier3, ...overrides?.tier3 }),
  };
}

/**
 * Get the policy for a specific tier (1-3).
 */
export function getTierPolicy(tiered: TieredReconnectPolicy, tier: 1 | 2 | 3): ReconnectPolicy {
  switch (tier) {
    case 1:
      return tiered.tier1;
    case 2:
      return tiered.tier2;
    case 3:
      return tiered.tier3;
  }
}

/**
 * Normalize a reconnect policy to ensure valid values.
 */
function normalizePolicy(policy: ReconnectPolicy): ReconnectPolicy {
  return {
    initialMs: Math.max(250, policy.initialMs),
    maxMs: Math.max(policy.initialMs, policy.maxMs),
    factor: clamp(policy.factor, 1.1, 10),
    jitter: clamp(policy.jitter, 0, 1),
    maxAttempts: Math.max(0, Math.floor(policy.maxAttempts)),
  };
}

export { computeBackoff, sleepWithAbort };

export function newConnectionId() {
  return randomUUID();
}
