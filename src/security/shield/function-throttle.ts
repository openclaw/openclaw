// ─────────────────────────────────────────────
//  OpenClaw Shield — Progressive Rate Limiting
//  Per-function throttling based on health score
//  Adapted from Kairos Shield Protocol (Layer 4)
//  By Kairos Lab
// ─────────────────────────────────────────────

import type { FunctionHealth, FunctionStatus } from "./function-health.js";

// ─── Types ───────────────────────────────────

export interface ThrottleConfig {
  functionName: string;
  healthScore: number;
  status: FunctionStatus;
  capacityPercent: number;
  queueEnabled: boolean;
}

export interface ThrottleDecision {
  allowed: boolean;
  retryAfter?: number;
}

// ─── Constants ───────────────────────────────

export const THROTTLE_RETRY_AFTER = 5;

// ─── Throttle Configuration ─────────────────

export function getThrottleConfig(health: FunctionHealth): ThrottleConfig {
  const base = {
    functionName: health.functionName,
    healthScore: health.healthScore,
    status: health.status,
  };

  switch (health.status) {
    case "HEALTHY":
      return { ...base, capacityPercent: 100, queueEnabled: false };

    case "DEGRADED": {
      const capacity = Math.round(50 + (health.healthScore - 50) * (45 / 29));
      return {
        ...base,
        capacityPercent: Math.max(50, Math.min(95, capacity)),
        queueEnabled: true,
      };
    }

    case "CRITICAL": {
      const capacity = Math.round(5 + (health.healthScore - 25) * (20 / 24));
      return {
        ...base,
        capacityPercent: Math.max(5, Math.min(25, capacity)),
        queueEnabled: false,
      };
    }

    case "CIRCUIT_OPEN":
      return { ...base, capacityPercent: 0, queueEnabled: false };
  }
}

export function isRequestAllowed(
  currentRPM: number,
  baselineRPM: number,
  capacityPercent: number,
): boolean {
  if (capacityPercent === 0) {
    return false;
  }
  if (capacityPercent === 100) {
    return true;
  }

  const allowedRPM = calculateAllowedRPM(baselineRPM, capacityPercent);
  return currentRPM < allowedRPM;
}

export function calculateAllowedRPM(baselineRPM: number, capacityPercent: number): number {
  if (capacityPercent === 0) {
    return 0;
  }
  return Math.max(1, Math.ceil((baselineRPM * capacityPercent) / 100));
}

export function makeThrottleDecision(
  health: FunctionHealth,
  currentRPM: number,
  baselineRPM: number,
): ThrottleDecision {
  const config = getThrottleConfig(health);

  if (config.capacityPercent === 0) {
    return { allowed: false, retryAfter: THROTTLE_RETRY_AFTER };
  }

  if (config.capacityPercent === 100) {
    return { allowed: true };
  }

  if (isRequestAllowed(currentRPM, baselineRPM, config.capacityPercent)) {
    return { allowed: true };
  }

  return { allowed: false, retryAfter: THROTTLE_RETRY_AFTER };
}
