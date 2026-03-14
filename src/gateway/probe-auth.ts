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
}): {
  auth: { token?: string; password?: string };
  warning?: string;
} {
  try {
    const auth = resolveGatewayProbeAuth(params);

    // Defensive: some secret ref resolutions intentionally degrade to "no auth"
    // for best-effort commands. In that case, still surface a warning so status
    // output doesn't misleadingly treat auth-less probes as generic timeouts.
    const mode = params.cfg.gateway?.auth?.mode;
    if (mode === "token") {
      const tokenCfg = (params.cfg.gateway?.auth as { token?: unknown } | undefined)?.token;
      if (!auth.token && tokenCfg && typeof tokenCfg === "object") {
        return {
          auth,
          warning:
            "gateway.auth.token SecretRef is unresolved in this command path; probing without configured auth credentials.",
        };
      }
    }
    if (mode === "password") {
      const passCfg = (params.cfg.gateway?.auth as { password?: unknown } | undefined)?.password;
      if (!auth.password && passCfg && typeof passCfg === "object") {
        return {
          auth,
          warning:
            "gateway.auth.password SecretRef is unresolved in this command path; probing without configured auth credentials.",
        };
      }
    }

    return { auth };
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
