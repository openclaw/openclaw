import type { OpenClawConfig } from "../config/config.js";
import { collectDurableServiceEnvVars } from "../config/state-dir-dotenv.js";
import { hasConfiguredSecretInput } from "../config/types.secrets.js";

type GatewayInstallAuthMode = NonNullable<NonNullable<OpenClawConfig["gateway"]>["auth"]>["mode"];

function hasExplicitGatewayInstallAuthMode(
  mode: GatewayInstallAuthMode | undefined,
): boolean | undefined {
  if (mode === "token") {
    return true;
  }
  if (mode === "password" || mode === "none" || mode === "trusted-proxy") {
    return false;
  }
  return undefined;
}

function hasConfiguredGatewayPasswordForInstall(cfg: OpenClawConfig): boolean {
  return hasConfiguredSecretInput(cfg.gateway?.auth?.password, cfg.secrets?.defaults);
}

function hasDurableGatewayPasswordEnvForInstall(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv,
): boolean {
  const durableServiceEnv = collectDurableServiceEnvVars({ env, config: cfg });
  return Boolean(
    durableServiceEnv.NEXUS_GATEWAY_PASSWORD?.trim() ||
    durableServiceEnv.CLAWDBOT_GATEWAY_PASSWORD?.trim(),
  );
}

export function shouldRequireGatewayTokenForInstall(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv,
): boolean {
  const explicitModeDecision = hasExplicitGatewayInstallAuthMode(cfg.gateway?.auth?.mode);
  if (explicitModeDecision !== undefined) {
    return explicitModeDecision;
  }

  if (hasConfiguredGatewayPasswordForInstall(cfg)) {
    return false;
  }

  // Service install should only infer password mode from durable sources that
  // survive outside the invoking shell.
  if (hasDurableGatewayPasswordEnvForInstall(cfg, env)) {
    return false;
  }

  return true;
}
