import type { loadConfig } from "../config/config.js";

export function resolveGatewayProbeAuth(cfg: ReturnType<typeof loadConfig>): {
  token?: string;
  password?: string;
} {
  const isRemoteMode = cfg.gateway?.mode === "remote";
  const remote = isRemoteMode ? cfg.gateway?.remote : undefined;
  const authToken = cfg.gateway?.auth?.token;
  const authPassword = cfg.gateway?.auth?.password;
  const token = isRemoteMode
    ? typeof remote?.token === "string" && remote.token.trim().length > 0
      ? remote.token.trim()
      : undefined
    : process.env.OPENCLAW_GATEWAY_TOKEN?.trim() ||
      (typeof authToken === "string" && authToken.trim().length > 0 ? authToken.trim() : undefined);
  const password =
    process.env.OPENCLAW_GATEWAY_PASSWORD?.trim() ||
    (isRemoteMode
      ? typeof remote?.password === "string" && remote.password.trim().length > 0
        ? remote.password.trim()
        : undefined
      : typeof authPassword === "string" && authPassword.trim().length > 0
        ? authPassword.trim()
        : undefined);
  return { token, password };
}

export function pickGatewaySelfPresence(presence: unknown): {
  host?: string;
  ip?: string;
  version?: string;
  platform?: string;
} | null {
  if (!Array.isArray(presence)) return null;
  const entries = presence as Array<Record<string, unknown>>;
  const self = entries.find((e) => e.mode === "gateway" && e.reason === "self") ?? null;
  if (!self) return null;
  return {
    host: typeof self.host === "string" ? self.host : undefined,
    ip: typeof self.ip === "string" ? self.ip : undefined,
    version: typeof self.version === "string" ? self.version : undefined,
    platform: typeof self.platform === "string" ? self.platform : undefined,
  };
}
