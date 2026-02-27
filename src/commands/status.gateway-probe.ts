import type { loadConfig } from "../config/config.js";
import { resolveGatewayProbeAuth as resolveGatewayProbeAuthByMode } from "../gateway/probe-auth.js";
export { pickGatewaySelfPresence } from "./gateway-presence.js";

export function resolveGatewayProbeAuth(cfg: ReturnType<typeof loadConfig>): {
  token?: string;
  password?: string;
} {
  return resolveGatewayProbeAuthByMode({
    cfg,
    mode: cfg.gateway?.mode === "remote" ? "remote" : "local",
    env: process.env,
  });
}
