import type { loadConfig } from "../config/config.js";
export { pickGatewaySelfPresence } from "./gateway-presence.js";

export function resolveGatewayProbeAuth(cfg: ReturnType<typeof loadConfig>): {
  token?: string;
  password?: string;
} {
  const isRemoteMode = cfg.gateway?.mode === "remote";
  const remote = isRemoteMode ? cfg.gateway?.remote : undefined;
  const authToken = cfg.gateway?.auth?.token;
  const authPassword = cfg.gateway?.auth?.password;
  const envToken =
    process.env.OPENCLAW_GATEWAY_TOKEN?.trim() || process.env.CLAWDBOT_GATEWAY_TOKEN?.trim();
  const envPassword =
    process.env.OPENCLAW_GATEWAY_PASSWORD?.trim() || process.env.CLAWDBOT_GATEWAY_PASSWORD?.trim();
  const token = isRemoteMode
    ? typeof remote?.token === "string" && remote.token.trim().length > 0
      ? remote.token.trim()
      : undefined
    : envToken ||
      (typeof authToken === "string" && authToken.trim().length > 0 ? authToken.trim() : undefined);
  const password =
    envPassword ||
    (isRemoteMode
      ? typeof remote?.password === "string" && remote.password.trim().length > 0
        ? remote.password.trim()
        : undefined
      : typeof authPassword === "string" && authPassword.trim().length > 0
        ? authPassword.trim()
        : undefined);
  return { token, password };
}
