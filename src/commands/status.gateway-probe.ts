import type { loadConfig } from "../config/config.js";
import { resolveGatewayProbeAuthSafe } from "../gateway/probe-auth.js";
export { pickGatewaySelfPresence } from "./gateway-presence.js";

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
