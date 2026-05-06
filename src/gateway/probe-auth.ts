import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import { resolveGatewayInteractiveSurfaceAuth } from "./auth-surface-resolution.js";
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
    remoteTokenFallback: policy.remoteTokenFallback,
  });
}

export async function resolveGatewayProbeAuthSafeWithSecretInputs(params: {
  cfg: OpenClawConfig;
  mode: "local" | "remote";
  env?: NodeJS.ProcessEnv;
  explicitAuth?: ExplicitGatewayAuth;
}): Promise<{
  auth: { token?: string; password?: string };
  warning?: string;
  failureReason?: string;
}> {
  const explicitAuth = resolveExplicitProbeAuth(params.explicitAuth);
  if (hasExplicitProbeAuth(explicitAuth)) {
    return {
      auth: explicitAuth,
    };
  }

  try {
    const auth = await resolveGatewayProbeAuthWithSecretInputs(params);
    const failureReason = await resolveLocalProbeFailureReason(params, auth);
    return failureReason ? { auth, failureReason } : { auth };
  } catch (error) {
    const result = {
      auth: {},
      warning: resolveGatewayProbeWarning(error),
    };
    const failureReason = await resolveLocalProbeFailureReason(params, result.auth);
    return failureReason ? { ...result, failureReason } : result;
  }
}

export function resolveGatewayProbeAuthSafe(params: {
  cfg: OpenClawConfig;
  mode: "local" | "remote";
  env?: NodeJS.ProcessEnv;
  explicitAuth?: ExplicitGatewayAuth;
}): {
  auth: { token?: string; password?: string };
  warning?: string;
  failureReason?: string;
} {
  const explicitAuth = resolveExplicitProbeAuth(params.explicitAuth);
  if (hasExplicitProbeAuth(explicitAuth)) {
    return {
      auth: explicitAuth,
    };
  }

  try {
    const auth = resolveGatewayProbeAuth(params);
    const failureReason = resolveLocalProbeFailureReasonSync(params, auth);
    return failureReason ? { auth, failureReason } : { auth };
  } catch (error) {
    const result = {
      auth: {},
      warning: resolveGatewayProbeWarning(error),
    };
    const failureReason = resolveLocalProbeFailureReasonSync(params, result.auth);
    return failureReason ? { ...result, failureReason } : result;
  }
}

async function resolveLocalProbeFailureReason(
  params: {
    cfg: OpenClawConfig;
    mode: "local" | "remote";
    env?: NodeJS.ProcessEnv;
    explicitAuth?: ExplicitGatewayAuth;
  },
  auth: { token?: string; password?: string },
): Promise<string | undefined> {
  if (params.mode !== "local" || auth.token || auth.password) {
    return undefined;
  }
  // Mirror the sync sibling: only fail-fast when an explicit auth mode is
  // configured that requires credentials. Skip when authMode is undefined,
  // "none", or "trusted-proxy" so open gateways without explicit auth config
  // are never blocked by the fail-fast path.
  const authMode = params.cfg.gateway?.auth?.mode;
  if (!authMode || authMode === "none" || authMode === "trusted-proxy") {
    return undefined;
  }
  return (
    await resolveGatewayInteractiveSurfaceAuth({
      config: params.cfg,
      env: params.env,
      explicitAuth: params.explicitAuth,
      surface: "local",
    })
  ).failureReason;
}

function resolveLocalProbeFailureReasonSync(
  params: {
    cfg: OpenClawConfig;
    mode: "local" | "remote";
    env?: NodeJS.ProcessEnv;
    explicitAuth?: ExplicitGatewayAuth;
  },
  auth: { token?: string; password?: string },
): string | undefined {
  if (params.mode !== "local" || auth.token || auth.password) {
    return undefined;
  }
  const authMode = params.cfg.gateway?.auth?.mode;
  if (authMode === "token") {
    return "Missing gateway auth token.";
  }
  if (authMode === "password") {
    return "Missing gateway auth password.";
  }
  if (authMode && authMode !== "none" && authMode !== "trusted-proxy") {
    return "Missing gateway auth credentials.";
  }
  return undefined;
}
