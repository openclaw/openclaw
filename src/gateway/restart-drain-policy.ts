import type { GatewayRestartConfig } from "../config/types.gateway.js";

export const DEFAULT_GATEWAY_RESTART_DRAIN_SECONDS = 60;
export const DEFAULT_GATEWAY_RESTART_ZOMBIE_TTL_SECONDS = 300;

export type GatewayRestartDrainPolicy = {
  drainSeconds: number;
  drainMs: number;
  zombieTtlSeconds: number;
  zombieTtlMs: number;
};

function normalizeSeconds(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(0, value);
}

export function resolveGatewayRestartDrainPolicy(
  config?: GatewayRestartConfig,
): GatewayRestartDrainPolicy {
  const drainSeconds = normalizeSeconds(
    config?.drainSeconds,
    DEFAULT_GATEWAY_RESTART_DRAIN_SECONDS,
  );
  const zombieTtlSeconds = normalizeSeconds(
    config?.zombieTtlSeconds,
    DEFAULT_GATEWAY_RESTART_ZOMBIE_TTL_SECONDS,
  );
  return {
    drainSeconds,
    drainMs: Math.floor(drainSeconds * 1000),
    zombieTtlSeconds,
    zombieTtlMs: Math.floor(zombieTtlSeconds * 1000),
  };
}
