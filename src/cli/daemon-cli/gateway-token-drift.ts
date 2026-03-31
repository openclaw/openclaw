import type { OpenClawConfig } from "../../config/config.js";
import { hasConfiguredSecretInput, resolveSecretInputRef } from "../../config/types.secrets.js";
import { trimToUndefined } from "../../gateway/credential-planner.js";
import { GatewaySecretRefUnavailableError } from "../../gateway/credentials.js";
import { resolveConfiguredSecretInputString } from "../../gateway/resolve-configured-secret-input-string.js";

function authModeDisablesToken(mode: string | undefined): boolean {
  return mode === "password" || mode === "none" || mode === "trusted-proxy";
}

function isPasswordFallbackActive(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
}): boolean {
  if (params.cfg.gateway?.auth?.mode !== undefined) {
    return false;
  }
  if (trimToUndefined(params.env.OPENCLAW_GATEWAY_PASSWORD)) {
    return true;
  }
  return hasConfiguredSecretInput(params.cfg.gateway?.auth?.password, params.cfg.secrets?.defaults);
}

export async function resolveGatewayTokenForDriftCheck(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): Promise<string | undefined> {
  const env = params.env ?? process.env;
  const mode = params.cfg.gateway?.auth?.mode;
  if (authModeDisablesToken(mode)) {
    return undefined;
  }
  if (isPasswordFallbackActive({ cfg: params.cfg, env })) {
    return undefined;
  }

  const tokenInput = params.cfg.gateway?.auth?.token;
  const tokenRef = resolveSecretInputRef({
    value: tokenInput,
    defaults: params.cfg.secrets?.defaults,
  }).ref;
  if (!tokenRef) {
    return trimToUndefined(tokenInput);
  }

  const resolved = await resolveConfiguredSecretInputString({
    config: params.cfg,
    env,
    value: tokenInput,
    path: "gateway.auth.token",
    unresolvedReasonStyle: "detailed",
  });
  if (resolved.value) {
    return resolved.value;
  }
  throw new GatewaySecretRefUnavailableError("gateway.auth.token");
}
