import {
  GATEWAY_RESTART_REPLACEMENT_TIMEOUT_MS,
  GATEWAY_SHUTDOWN_RESERVE_MS,
  GATEWAY_SUPERVISOR_EXIT_MARGIN_MS,
} from "./gateway-shutdown-budget.js";
import type { GatewayRestartIntent } from "./restart-intent.js";

const DEFAULT_RESTART_DEFERRAL_TIMEOUT_MS = 300_000;

export function resolveGatewayRestartDeferralTimeoutMs(): number;
export function resolveGatewayRestartDeferralTimeoutMs(timeoutMs: unknown): number | undefined;
export function resolveGatewayRestartDeferralTimeoutMs(timeoutMs?: unknown): number | undefined {
  if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs)) {
    return DEFAULT_RESTART_DEFERRAL_TIMEOUT_MS;
  }
  return timeoutMs > 0 ? Math.floor(timeoutMs) : undefined;
}

export function resolveGatewayRestartDrainTimeoutMs(intent?: GatewayRestartIntent) {
  const reserveMs = GATEWAY_SHUTDOWN_RESERVE_MS + GATEWAY_SUPERVISOR_EXIT_MARGIN_MS;
  const waitMs =
    intent?.waitMs ??
    (intent?.force ? GATEWAY_RESTART_REPLACEMENT_TIMEOUT_MS - reserveMs : undefined);
  const exhausted = intent?.drainBudgetExhausted || (intent?.force && waitMs === 0);
  return exhausted ? 0 : resolveGatewayRestartDeferralTimeoutMs(waitMs);
}
