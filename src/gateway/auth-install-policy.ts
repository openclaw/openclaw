import type { OpenClawConfig } from "../config/config.js";
import { collectConfigServiceEnvVars } from "../config/env-vars.js";
import { hasConfiguredSecretInput } from "../config/types.secrets.js";

export function shouldRequireGatewayTokenForInstall(
  cfg: OpenClawConfig,
  _env: NodeJS.ProcessEnv,
): boolean {
  const mode = cfg.gateway?.auth?.mode;
  if (mode === "token") {
    return true;
  }
  if (mode === "password" || mode === "none" || mode === "trusted-proxy") {
    return false;
  }

  const hasConfiguredPassword = hasConfiguredSecretInput(
    cfg.gateway?.auth?.password,
    cfg.secrets?.defaults,
  );
  if (hasConfiguredPassword) {
    return false;
  }

  // Service install should only infer password mode from durable sources that
  // survive outside the invoking shell.
  const configServiceEnv = collectConfigServiceEnvVars(cfg);
  const hasConfiguredPasswordEnvCandidate = Boolean(
    configServiceEnv.OPENCLAW_GATEWAY_PASSWORD?.trim() ||
    configServiceEnv.CLAWDBOT_GATEWAY_PASSWORD?.trim(),
  );
  if (hasConfiguredPasswordEnvCandidate) {
    return false;
  }

  return true;
}
