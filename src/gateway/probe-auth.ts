import type { OpenClawConfig } from "../config/config.js";
import { resolveGatewayCredentialsWithSecretInputs } from "./call.js";
import {
  type ExplicitGatewayAuth,
  isGatewaySecretRefUnavailableError,
  resolveGatewayProbeCredentialsFromConfig,
} from "./credentials.js";

function buildGatewayProbeCredentialPolicy(params: {
  cfg: OpenClawConfig;
  mode: "local" | "remote";
  env?: NodeJS.ProcessEnv;
  explicitAuth?: ExplicitGatewayAuth;
}) {
  return {
    config: params.cfg,
    cfg: params.cfg,
    env: params.env,
    explicitAuth: params.explicitAuth,
    modeOverride: params.mode,
    mode: params.mode,
    includeLegacyEnv: false,
    remoteTokenFallback: "remote-only" as const,
  };
}

export function resolveGatewayProbeAuth(params: {
  cfg: OpenClawConfig;
  mode: "local" | "remote";
  env?: NodeJS.ProcessEnv;
}): { token?: string; password?: string } {
  const policy = buildGatewayProbeCredentialPolicy(params);
  return resolveGatewayProbeCredentialsFromConfig(policy);
}

export async function resolveGatewayProbeAuthWithSecretInputs(params: {
  cfg: OpenClawConfig;
  mode: "local" | "remote";
  env?: NodeJS.ProcessEnv;
  explicitAuth?: ExplicitGatewayAuth;
}): Promise<{ token?: string; password?: string }> {
  const policy = buildGatewayProbeCredentialPolicy(params);
  return await resolveGatewayCredentialsWithSecretInputs({
    config: policy.config,
    env: policy.env,
    explicitAuth: policy.explicitAuth,
    modeOverride: policy.modeOverride,
    includeLegacyEnv: policy.includeLegacyEnv,
    remoteTokenFallback: policy.remoteTokenFallback,
  });
}

export function resolveGatewayProbeAuthSafe(params: {
  cfg: OpenClawConfig;
  mode: "local" | "remote";
  env?: NodeJS.ProcessEnv;
  explicitAuth?: ExplicitGatewayAuth;
}): {
  auth: { token?: string; password?: string };
  warning?: string;
} {
  const explicitToken = params.explicitAuth?.token?.trim();
  const explicitPassword = params.explicitAuth?.password?.trim();
  if (explicitToken || explicitPassword) {
    return {
      auth: {
        ...(explicitToken ? { token: explicitToken } : {}),
        ...(explicitPassword ? { password: explicitPassword } : {}),
      },
    };
  }

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
