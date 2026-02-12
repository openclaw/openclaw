import type { GatewayIdentityKind, GatewayIdentityMode } from "../config/types.gateway.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

export const GATEWAY_IDENTITY_MODE_ENV = "OPENCLAW_GATEWAY_IDENTITY_MODE";

// Upstream reports itself as "upstream" by default.
// Forks can override via config/env (or patch this constant in distribution builds).
export const DEFAULT_GATEWAY_IDENTITY_KIND: GatewayIdentityKind = "upstream";

type GatewayIdentitySource = "default" | "config" | "env";

export type GatewayInstanceIdentity = {
  kind: GatewayIdentityKind;
  mode: GatewayIdentityMode;
  source: GatewayIdentitySource;
};

function parseIdentityMode(raw: unknown): GatewayIdentityMode | undefined {
  if (typeof raw !== "string") {
    return undefined;
  }
  const normalized = raw.trim().toLowerCase();
  if (normalized === "auto" || normalized === "upstream" || normalized === "fork") {
    return normalized;
  }
  return undefined;
}

export function resolveGatewayInstanceIdentity(params?: {
  cfg?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  defaultKind?: GatewayIdentityKind;
}): GatewayInstanceIdentity {
  const cfg = params?.cfg;
  const env = params?.env ?? process.env;
  const defaultKind = params?.defaultKind ?? DEFAULT_GATEWAY_IDENTITY_KIND;

  const configMode = parseIdentityMode(cfg?.gateway?.identity?.mode);
  const envMode = parseIdentityMode(env[GATEWAY_IDENTITY_MODE_ENV]);

  const mode = envMode ?? configMode ?? "auto";
  const source: GatewayIdentitySource = envMode ? "env" : configMode ? "config" : "default";
  const kind = mode === "auto" ? defaultKind : mode;

  return { kind, mode, source };
}
