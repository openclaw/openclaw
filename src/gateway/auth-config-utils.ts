import type { GatewayAuthConfig, OpenClawConfig } from "../config/config.js";
import { resolveSecretInputRef } from "../config/types.secrets.js";
import { resolveRequiredConfiguredSecretRefInputString } from "./resolve-configured-secret-input-string.js";

export function withGatewayAuthPassword(cfg: OpenClawConfig, password: string): OpenClawConfig {
  return {
    ...cfg,
    gateway: {
      ...cfg.gateway,
      auth: {
        ...cfg.gateway?.auth,
        password,
      },
    },
  };
}

function shouldResolveGatewayPasswordSecretRef(params: {
  mode?: GatewayAuthConfig["mode"];
  hasPasswordCandidate: boolean;
  hasTokenCandidate: boolean;
}): boolean {
  if (params.hasPasswordCandidate) {
    return false;
  }
  if (params.mode === "password") {
    return true;
  }
  if (params.mode === "token" || params.mode === "none" || params.mode === "trusted-proxy") {
    return false;
  }
  return !params.hasTokenCandidate;
}

export async function resolveGatewayPasswordSecretRef(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  mode?: GatewayAuthConfig["mode"];
  hasPasswordCandidate: boolean;
  hasTokenCandidate: boolean;
}): Promise<OpenClawConfig> {
  const authPassword = params.cfg.gateway?.auth?.password;
  const { ref } = resolveSecretInputRef({
    value: authPassword,
    defaults: params.cfg.secrets?.defaults,
  });
  if (!ref) {
    return params.cfg;
  }
  if (
    !shouldResolveGatewayPasswordSecretRef({
      mode: params.mode,
      hasPasswordCandidate: params.hasPasswordCandidate,
      hasTokenCandidate: params.hasTokenCandidate,
    })
  ) {
    return params.cfg;
  }
  const value = await resolveRequiredConfiguredSecretRefInputString({
    config: params.cfg,
    env: params.env,
    value: authPassword,
    path: "gateway.auth.password",
  });
  if (!value) {
    return params.cfg;
  }
  return withGatewayAuthPassword(params.cfg, value);
}
