import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveGatewayCredentialsWithSecretInputs } from "./credentials-secret-inputs.js";
import {
  type ExplicitGatewayAuth,
  isGatewaySecretRefUnavailableError,
  resolveGatewayProbeCredentialsFromConfig,
} from "./credentials.js";
export { resolveGatewayProbeTarget } from "./probe-target.js";
export type { GatewayProbeTargetResolution } from "./probe-target.js";

function buildGatewayProbeCredentialPolicy(params: {
  cfg: OpenClawConfig;
  mode: "local" | "remote";
  env?: NodeJS.ProcessEnv;
  explicitAuth?: ExplicitGatewayAuth;
}) {
  const cfg = resolveGatewayProbeCredentialConfig(params);
  return {
    config: cfg,
    cfg,
    env: params.env,
    explicitAuth: params.explicitAuth,
    modeOverride: params.mode,
    mode: params.mode,
    remoteTokenFallback: "remote-only" as const,
  };
}

function resolveGatewayProbeCredentialConfig(params: {
  cfg: OpenClawConfig;
  mode: "local" | "remote";
}): OpenClawConfig {
  if (params.mode !== "local") {
    return params.cfg;
  }

  const remote = params.cfg.gateway?.remote;
  if (!remote || (remote.token === undefined && remote.password === undefined)) {
    return params.cfg;
  }

  // Local probes must not borrow remote credentials; otherwise a configured
  // remote token can mask missing local auth and make status/doctor lie.
  const remoteWithoutAuth = { ...remote };
  delete remoteWithoutAuth.token;
  delete remoteWithoutAuth.password;
  return {
    ...params.cfg,
    gateway: {
      ...params.cfg.gateway,
      remote: remoteWithoutAuth,
    },
  };
}

function resolveExplicitProbeAuth(explicitAuth?: ExplicitGatewayAuth): {
  token?: string;
  password?: string;
} {
  const token = normalizeOptionalString(explicitAuth?.token);
  const password = normalizeOptionalString(explicitAuth?.password);
  return { token, password };
}

function hasExplicitProbeAuth(auth: { token?: string; password?: string }): boolean {
  return Boolean(auth.token || auth.password);
}

function buildUnresolvedProbeAuthWarning(path: string): string {
  return `${path} SecretRef is unresolved in this command path; probing without configured auth credentials.`;
}

function resolveGatewayProbeWarning(error: unknown): string | undefined {
  if (!isGatewaySecretRefUnavailableError(error)) {
    throw error;
  }
  return buildUnresolvedProbeAuthWarning(error.path);
}

/**
 * Resolves raw config/env probe credentials without SecretRef lookup for parity
 * tests and lightweight status paths.
 */
export function resolveGatewayProbeAuth(params: {
  cfg: OpenClawConfig;
  mode: "local" | "remote";
  env?: NodeJS.ProcessEnv;
}): { token?: string; password?: string } {
  const policy = buildGatewayProbeCredentialPolicy(params);
  return resolveGatewayProbeCredentialsFromConfig(policy);
}

/**
 * Resolves auth for Gateway probes that may need SecretRef-backed credentials.
 * Remote probes intentionally fall back only to remote credentials after env/CLI
 * sources so a local token does not authorize the wrong Gateway surface.
 */
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
    remoteTokenFallback: policy.remoteTokenFallback,
  });
}

/**
 * Best-effort async probe auth for status/doctor paths: explicit CLI auth wins,
 * unresolved SecretRefs become warnings, and callers can still probe unauthenticated.
 */
export async function resolveGatewayProbeAuthSafeWithSecretInputs(params: {
  cfg: OpenClawConfig;
  mode: "local" | "remote";
  env?: NodeJS.ProcessEnv;
  explicitAuth?: ExplicitGatewayAuth;
}): Promise<{
  auth: { token?: string; password?: string };
  warning?: string;
}> {
  const explicitAuth = resolveExplicitProbeAuth(params.explicitAuth);
  if (hasExplicitProbeAuth(explicitAuth)) {
    return {
      auth: explicitAuth,
    };
  }

  try {
    const auth = await resolveGatewayProbeAuthWithSecretInputs(params);
    return { auth };
  } catch (error) {
    return {
      auth: {},
      warning: resolveGatewayProbeWarning(error),
    };
  }
}

/**
 * Sync variant for callers that only inspect config/env credentials; unresolved
 * SecretRefs produce the same warning shape as the async helper.
 */
export function resolveGatewayProbeAuthSafe(params: {
  cfg: OpenClawConfig;
  mode: "local" | "remote";
  env?: NodeJS.ProcessEnv;
  explicitAuth?: ExplicitGatewayAuth;
}): {
  auth: { token?: string; password?: string };
  warning?: string;
} {
  const explicitAuth = resolveExplicitProbeAuth(params.explicitAuth);
  if (hasExplicitProbeAuth(explicitAuth)) {
    return {
      auth: explicitAuth,
    };
  }

  try {
    return { auth: resolveGatewayProbeAuth(params) };
  } catch (error) {
    return {
      auth: {},
      warning: resolveGatewayProbeWarning(error),
    };
  }
}
