import type { OpenClawConfig } from "../config/config.js";
import { isTruthyEnvValue } from "../infra/env.js";

export const OPENCLAW_SKIP_AUTH_WARNING_ENV = "OPENCLAW_SKIP_AUTH_WARNING";

export type GatewayExposureCheck = {
  isUnsafe: boolean;
  bindHost: string;
};

function isPublicWildcardBindHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return normalized === "0.0.0.0" || normalized === "::";
}

function resolveBindHostFromConfig(cfg: OpenClawConfig): string {
  const bindMode = cfg.gateway?.bind ?? "loopback";
  if (bindMode === "lan") {
    return "0.0.0.0";
  }
  if (bindMode === "custom") {
    return cfg.gateway?.customBindHost?.trim() ?? "";
  }
  if (bindMode === "loopback") {
    return "127.0.0.1";
  }
  return "";
}

export function assessGatewayExposureWarning(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  bindHost?: string;
}): GatewayExposureCheck {
  const env = params.env ?? process.env;
  const bindHost = params.bindHost ?? resolveBindHostFromConfig(params.cfg);

  return {
    isUnsafe:
      !isTruthyEnvValue(env[OPENCLAW_SKIP_AUTH_WARNING_ENV]) &&
      params.cfg.gateway?.auth?.mode === "none" &&
      isPublicWildcardBindHost(bindHost),
    bindHost,
  };
}
