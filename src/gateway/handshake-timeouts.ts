import type { GatewayConfig } from "../config/types.gateway.js";

export const DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS = 15_000;
export const MIN_CONNECT_CHALLENGE_TIMEOUT_MS = 250;
export const MAX_CONNECT_CHALLENGE_TIMEOUT_MS = DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS;

const MIN_HANDSHAKE_TIMEOUT_MS = 1_000;
const MAX_HANDSHAKE_TIMEOUT_MS = 120_000;

export function clampConnectChallengeTimeoutMs(timeoutMs: number): number {
  return Math.max(
    MIN_CONNECT_CHALLENGE_TIMEOUT_MS,
    Math.min(MAX_CONNECT_CHALLENGE_TIMEOUT_MS, timeoutMs),
  );
}

export function resolveConnectChallengeTimeoutMs(timeoutMs?: number | null): number {
  return typeof timeoutMs === "number" && Number.isFinite(timeoutMs)
    ? clampConnectChallengeTimeoutMs(timeoutMs)
    : DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS;
}

/**
 * Parse a raw env string into a validated timeout, or undefined to fall through.
 * `enforceMin` controls whether the lower bound (1000ms) is applied:
 * - true (default): full range validation for production env var
 * - false: skip the minimum so tests can use sub-second timeouts (e.g. 20ms)
 * The upper bound (120000ms) is always enforced to prevent timer overflow.
 */
function parseTimeoutOverride(raw?: string, enforceMin = true): number | undefined {
  const value = raw?.trim();
  if (!value) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return undefined;
  }
  if (enforceMin && parsed < MIN_HANDSHAKE_TIMEOUT_MS) {
    return undefined;
  }
  if (parsed > MAX_HANDSHAKE_TIMEOUT_MS) {
    return undefined;
  }
  return parsed;
}

/** Validate a config-supplied timeout: must be finite, positive, and within bounds. */
function validateConfigTimeout(value?: number): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  if (value < MIN_HANDSHAKE_TIMEOUT_MS || value > MAX_HANDSHAKE_TIMEOUT_MS) {
    return undefined;
  }
  return value;
}

/**
 * Resolve the preauth handshake timeout with a 4-layer priority chain:
 * 1. OPENCLAW_HANDSHAKE_TIMEOUT_MS env var (range-validated, 1000-120000)
 * 2. OPENCLAW_TEST_HANDSHAKE_TIMEOUT_MS env var (VITEST only, no minimum)
 * 3. gateway.handshakeTimeoutMs config (range-validated, 1000-120000)
 * 4. DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS (15s)
 */
export function getPreauthHandshakeTimeoutMsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  gatewayConfig?: GatewayConfig,
): number {
  return (
    parseTimeoutOverride(env.OPENCLAW_HANDSHAKE_TIMEOUT_MS) ??
    parseTimeoutOverride(
      env.VITEST ? env.OPENCLAW_TEST_HANDSHAKE_TIMEOUT_MS : undefined,
      false, // test env var: skip minimum so tests can use fast sub-second timeouts
    ) ??
    validateConfigTimeout(gatewayConfig?.handshakeTimeoutMs) ??
    DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS
  );
}
