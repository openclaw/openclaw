import type { GatewayServiceEnv } from "./service-types.js";

export const OPENCLAW_SYSTEMD_SYSTEM_ENV = "OPENCLAW_SYSTEMD_SYSTEM";

function isTruthyFlag(value: string | undefined): boolean {
  if (!value) {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

export function isSystemdSystemScope(
  env: GatewayServiceEnv = process.env as GatewayServiceEnv,
): boolean {
  return isTruthyFlag(env[OPENCLAW_SYSTEMD_SYSTEM_ENV]);
}

export function withSystemdSystemScopeEnv(
  env: GatewayServiceEnv,
  opts: { system?: boolean },
): GatewayServiceEnv {
  if (!opts.system) {
    return env;
  }
  return {
    ...env,
    [OPENCLAW_SYSTEMD_SYSTEM_ENV]: "1",
  };
}
