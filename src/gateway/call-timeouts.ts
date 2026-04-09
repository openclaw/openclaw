import type { OpenClawConfig } from "../config/config.js";
import { resolveConfiguredConnectChallengeTimeoutMs } from "./handshake-timeouts.js";

export const DEFAULT_GATEWAY_RPC_TIMEOUT_MS = 10_000;
export const DEFAULT_GATEWAY_FINAL_RESPONSE_TIMEOUT_MS = 90_000;
export const DEFAULT_GATEWAY_SESSION_SETTLE_TIMEOUT_MS = 15_000;
const MAX_SAFE_TIMEOUT_MS = 2_147_483_647;

function clampSafeTimeoutMs(timeoutMs: number): number {
  return Math.max(1, Math.min(Math.floor(timeoutMs), MAX_SAFE_TIMEOUT_MS));
}

function readConfiguredTimeoutMs(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? clampSafeTimeoutMs(value)
    : undefined;
}

export function resolveGatewayRpcTimeoutMs(config?: OpenClawConfig): number {
  return readConfiguredTimeoutMs(config?.gateway?.timeoutMs) ?? DEFAULT_GATEWAY_RPC_TIMEOUT_MS;
}

export function resolveGatewayFinalResponseTimeoutMs(config?: OpenClawConfig): number {
  return (
    readConfiguredTimeoutMs(config?.gateway?.finalResponseTimeoutMs) ??
    Math.max(resolveGatewayRpcTimeoutMs(config), DEFAULT_GATEWAY_FINAL_RESPONSE_TIMEOUT_MS)
  );
}

export function resolveGatewaySessionSettleTimeoutMs(config?: OpenClawConfig): number {
  return (
    readConfiguredTimeoutMs(config?.gateway?.sessionSettleTimeoutMs) ??
    DEFAULT_GATEWAY_SESSION_SETTLE_TIMEOUT_MS
  );
}

export function resolveGatewayWaitCallTimeoutMs(
  config: OpenClawConfig | undefined,
  waitTimeoutMs: number,
): number {
  return clampSafeTimeoutMs(
    Math.max(0, Math.floor(waitTimeoutMs)) + resolveGatewaySessionSettleTimeoutMs(config),
  );
}

export function resolveGatewayCallTimeouts(params: {
  config?: OpenClawConfig;
  timeoutMs?: number | null;
  expectFinal?: boolean;
  env?: NodeJS.ProcessEnv;
}): {
  timeoutMs: number;
  requestTimeoutMs: number;
  connectChallengeTimeoutMs: number;
  safeTimerTimeoutMs: number;
} {
  const explicitTimeoutMs = readConfiguredTimeoutMs(params.timeoutMs);
  const timeoutMs =
    explicitTimeoutMs ??
    (params.expectFinal
      ? resolveGatewayFinalResponseTimeoutMs(params.config)
      : resolveGatewayRpcTimeoutMs(params.config));
  const configuredConnectChallengeTimeoutMs = resolveConfiguredConnectChallengeTimeoutMs(
    params.config,
    params.env,
  );
  return {
    timeoutMs,
    requestTimeoutMs: timeoutMs,
    connectChallengeTimeoutMs: Math.max(
      1,
      Math.min(configuredConnectChallengeTimeoutMs, timeoutMs),
    ),
    safeTimerTimeoutMs: clampSafeTimeoutMs(timeoutMs),
  };
}
