import type { loadConfig } from "../config/config.js";
import { resolveGatewayProbeAuthSafe } from "../gateway/probe-auth.js";
import type { GatewayProbeResult } from "../gateway/probe.js";
export { pickGatewaySelfPresence } from "./gateway-presence.js";

const MISSING_SCOPE_PATTERN = /\bmissing scope\b/i;

export function resolveGatewayProbeAuthResolution(cfg: ReturnType<typeof loadConfig>): {
  auth: {
    token?: string;
    password?: string;
  };
  warning?: string;
} {
  return resolveGatewayProbeAuthSafe({
    cfg,
    mode: cfg.gateway?.mode === "remote" ? "remote" : "local",
    env: process.env,
  });
}

export function resolveGatewayProbeAuth(cfg: ReturnType<typeof loadConfig>): {
  token?: string;
  password?: string;
} {
  return resolveGatewayProbeAuthResolution(cfg).auth;
}

export function isScopeLimitedProbeFailure(probe: GatewayProbeResult | null): boolean {
  if (!probe || probe.ok || probe.connectLatencyMs == null) {
    return false;
  }
  return MISSING_SCOPE_PATTERN.test(probe.error ?? "");
}

export function isGatewayProbeReachable(probe: GatewayProbeResult | null): boolean {
  return probe?.ok === true || isScopeLimitedProbeFailure(probe);
}
