// Gateway probe auth resolver.
// Adapts gateway credential precedence for local/remote reachability checks.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveGatewayInteractiveSurfaceAuth } from "./auth-surface-resolution.js";
import { resolveGatewayCredentialsWithSecretInputs } from "./credentials-secret-inputs.js";
import {
  type ExplicitGatewayAuth,
  isGatewaySecretRefUnavailableError,
  resolveGatewayProbeCredentialsFromConfig,
} from "./credentials.js";
export { resolveGatewayProbeTarget } from "./probe-target.js";
export type { GatewayProbeTargetResolution } from "./probe-target.js";

// Probe auth adapts normal gateway credential precedence for reachability
// checks. Local probes must not accidentally consume remote gateway credentials
// from config when they are only checking the embedded/local gateway.
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

export function resolveGatewayProbeCredentialConfig(params: {
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

  // Strip remote auth only for local probes; otherwise remote credentials can
  // mask a missing local token and make the wrong gateway look healthy.
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

/** Resolves synchronous probe auth, throwing when configured secrets cannot be read. */
export function resolveGatewayProbeAuth(params: {
  cfg: OpenClawConfig;
  mode: "local" | "remote";
  env?: NodeJS.ProcessEnv;
}): { token?: string; password?: string } {
  const policy = buildGatewayProbeCredentialPolicy(params);
  return resolveGatewayProbeCredentialsFromConfig(policy);
}

/** Resolves probe auth with async SecretRef support. */
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

/** Resolves probe auth without throwing for unavailable SecretRefs, returning a warning. */
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

/** Synchronous safe probe auth wrapper for config-only credential paths. */
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
  // Paired CLI installs can have a cached operator device token that
  // probeGateway resolves itself via the device-identity path. Don't
  // fail-fast when that path can still succeed, otherwise the caller
  // returns `{ok: false, error: <missing local auth>}` before probeGateway
  // gets a chance to attach the cached device token.
  if (await hasCachedPairedDeviceToken(params.env)) {
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

export async function hasCachedPairedDeviceToken(env?: NodeJS.ProcessEnv): Promise<boolean> {
  // Mirror probeGateway's device-identity check: only attach a paired
  // identity when this CLI has a cached operator device token. If the
  // resolution throws (read-only state dir, missing identity file, etc.)
  // we treat it as "no cached token" and let the failure reason apply.
  try {
    const [
      { loadDeviceIdentityIfPresent },
      { resolveStateDir },
      { loadDeviceAuthToken },
      pathModule,
    ] = await Promise.all([
      import("../infra/device-identity.js"),
      import("../config/paths.js"),
      import("../infra/device-auth-store.js"),
      import("node:path"),
    ]);
    const stateDir = resolveStateDir(env);
    const identity = loadDeviceIdentityIfPresent(
      pathModule.join(stateDir, "identity", "device.json"),
    );
    if (!identity) {
      return false;
    }
    return Boolean(loadDeviceAuthToken({ deviceId: identity.deviceId, role: "operator", env }));
  } catch {
    return false;
  }
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
