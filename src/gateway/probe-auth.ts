import type { OpenClawConfig } from "../config/config.js";
import { resolveGatewayCredentialsWithSecretInputs } from "./call.js";
import {
  type ExplicitGatewayAuth,
  isGatewaySecretRefUnavailableError,
  resolveGatewayCredentialsFromConfig,
} from "./credentials.js";

export function resolveGatewayProbeAuth(params: {
  cfg: OpenClawConfig;
  mode: "local" | "remote";
  env?: NodeJS.ProcessEnv;
}): { token?: string; password?: string } {
  return resolveGatewayCredentialsFromConfig({
    cfg: params.cfg,
    env: params.env,
    modeOverride: params.mode,
    includeLegacyEnv: false,
    remoteTokenFallback: "remote-only",
  });
}

export async function resolveGatewayProbeAuthWithSecretInputs(params: {
  cfg: OpenClawConfig;
  mode: "local" | "remote";
  env?: NodeJS.ProcessEnv;
  explicitAuth?: ExplicitGatewayAuth;
}): Promise<{ token?: string; password?: string }> {
  return await resolveGatewayCredentialsWithSecretInputs({
    config: params.cfg,
    env: params.env,
    explicitAuth: params.explicitAuth,
    modeOverride: params.mode,
    includeLegacyEnv: false,
    remoteTokenFallback: "remote-only",
  });
}

export function resolveGatewayProbeAuthSafe(params: {
  cfg: OpenClawConfig;
  mode: "local" | "remote";
  env?: NodeJS.ProcessEnv;
}): {
  auth: { token?: string; password?: string };
  warning?: string;
} {
  try {
    return { auth: resolveGatewayProbeAuth(params) };
  } catch (error) {
    if (!isGatewaySecretRefUnavailableError(error)) {
      throw error;
    }
    return {
      auth: {},
      warning: `${error.path} SecretRef is unresolved in this command path; probing without configured auth credentials.`,
    };
  }
}
