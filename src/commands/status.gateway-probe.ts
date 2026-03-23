import type { loadConfig } from "../config/config.js";
import { resolveGatewayProbeAuthSafeWithSecretInputs } from "../gateway/probe-auth.js";
export { pickGatewaySelfPresence } from "./gateway-presence.js";

export async function resolveGatewayProbeAuthResolution(
  cfg: ReturnType<typeof loadConfig>,
): Promise<{
  auth: {
    token?: string;
    password?: string;
  };
  warning?: string;
}> {
  return resolveGatewayProbeAuthSafeWithSecretInputs({
    cfg,
    mode: cfg.gateway?.mode === "remote" ? "remote" : "local",
    env: process.env,
  });
}

export async function resolveGatewayProbeAuth(cfg: ReturnType<typeof loadConfig>): Promise<{
  token?: string;
  password?: string;
}> {
  return (await resolveGatewayProbeAuthResolution(cfg)).auth;
}
