import type { OpenClawConfig } from "../config/config.js";
import { containsEnvVarReference } from "../config/env-substitution.js";
import { hasConfiguredSecretInput, resolveSecretInputRef } from "../config/types.secrets.js";

export type GatewayCredentialInputPath =
  | "gateway.auth.token"
  | "gateway.auth.password"
  | "gateway.remote.token"
  | "gateway.remote.password";

export type GatewayConfiguredCredentialInput = {
  path: GatewayCredentialInputPath;
  configured: boolean;
  value?: string;
  refPath?: GatewayCredentialInputPath;
  hasSecretRef: boolean;
};

export type GatewayCredentialPlan = {
  configuredMode: "local" | "remote";
  authMode?: string;
  envToken?: string;
  envPassword?: string;
  localToken: GatewayConfiguredCredentialInput;
  localPassword: GatewayConfiguredCredentialInput;
  remoteToken: GatewayConfiguredCredentialInput;
  remotePassword: GatewayConfiguredCredentialInput;
  localTokenCanWin: boolean;
  localPasswordCanWin: boolean;
  localTokenSurfaceActive: boolean;
  tokenCanWin: boolean;
  passwordCanWin: boolean;
  remoteMode: boolean;
  remoteUrlConfigured: boolean;
  tailscaleRemoteExposure: boolean;
  remoteEnabled: boolean;
  remoteConfiguredSurface: boolean;
  remoteTokenFallbackActive: boolean;
  remoteTokenActive: boolean;
  remotePasswordFallbackActive: boolean;
  remotePasswordActive: boolean;
};

type GatewaySecretDefaults = NonNullable<OpenClawConfig["secrets"]>["defaults"];

function readGatewayEnv(
  env: NodeJS.ProcessEnv,
  names: readonly string[],
  includeLegacyEnv: boolean,
): string | undefined {
  const keys = includeLegacyEnv ? names : names.slice(0, 1);
  for (const name of keys) {
    const value = trimToUndefined(env[name]);
    if (value) {
      return value;
    }
  }
  return undefined;
}

export function trimToUndefined(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Like trimToUndefined but also rejects unresolved env var placeholders (e.g. `${VAR}`).
 * This prevents literal placeholder strings like `${OPENCLAW_GATEWAY_TOKEN}` from being
 * accepted as valid credentials when the referenced env var is missing.
 * Note: legitimate credential values containing literal `${UPPER_CASE}` patterns will
 * also be rejected, but this is an extremely unlikely edge case.
 */
export function trimCredentialToUndefined(value: unknown): string | undefined {
  const trimmed = trimToUndefined(value);
  if (trimmed && containsEnvVarReference(trimmed)) {
    return undefined;
  }
  return trimmed;
}

export function readGatewayTokenEnv(
  env: NodeJS.ProcessEnv = process.env,
  includeLegacyEnv = true,
): string | undefined {
  return readGatewayEnv(
    env,
    ["OPENCLAW_GATEWAY_TOKEN", "CLAWDBOT_GATEWAY_TOKEN"],
    includeLegacyEnv,
  );
}

export function readGatewayPasswordEnv(
  env: NodeJS.ProcessEnv = process.env,
  includeLegacyEnv = true,
): string | undefined {
  return readGatewayEnv(
    env,
    ["OPENCLAW_GATEWAY_PASSWORD", "CLAWDBOT_GATEWAY_PASSWORD"],
    includeLegacyEnv,
  );
}

export function hasGatewayTokenEnvCandidate(
  env: NodeJS.ProcessEnv = process.env,
  includeLegacyEnv = true,
): boolean {
  return Boolean(readGatewayTokenEnv(env, includeLegacyEnv));
}

export function hasGatewayPasswordEnvCandidate(
  env: NodeJS.ProcessEnv = process.env,
  includeLegacyEnv = true,
): boolean {
  return Boolean(readGatewayPasswordEnv(env, includeLegacyEnv));
}

function resolveConfiguredGatewayCredentialInput(params: {
  value: unknown;
  defaults?: GatewaySecretDefaults;
  path: GatewayCredentialInputPath;
}): GatewayConfiguredCredentialInput {
  const ref = resolveSecretInputRef({
    value: params.value,
    defaults: params.defaults,
  }).ref;
  return {
    path: params.path,
    configured: hasConfiguredSecretInput(params.value, params.defaults),
    value: ref ? undefined : trimToUndefined(params.value),
    refPath: ref ? params.path : undefined,
    hasSecretRef: ref !== null,
  };
}

export function createGatewayCredentialPlan(params: {
  config: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  includeLegacyEnv?: boolean;
  defaults?: GatewaySecretDefaults;
}): GatewayCredentialPlan {
  const env = params.env ?? process.env;
  const includeLegacyEnv = params.includeLegacyEnv ?? true;
  const gateway = params.config.gateway;
  const remote = gateway?.remote;
  const defaults = params.defaults ?? params.config.secrets?.defaults;
  const authMode = gateway?.auth?.mode;
  const envToken = readGatewayTokenEnv(env, includeLegacyEnv);
  const envPassword = readGatewayPasswordEnv(env, includeLegacyEnv);

  const localToken = resolveConfiguredGatewayCredentialInput({
    value: gateway?.auth?.token,
    defaults,
    path: "gateway.auth.token",
  });
  const localPassword = resolveConfiguredGatewayCredentialInput({
    value: gateway?.auth?.password,
    defaults,
    path: "gateway.auth.password",
  });
  const remoteToken = resolveConfiguredGatewayCredentialInput({
    value: remote?.token,
    defaults,
    path: "gateway.remote.token",
  });
  const remotePassword = resolveConfiguredGatewayCredentialInput({
    value: remote?.password,
    defaults,
    path: "gateway.remote.password",
  });

  const localTokenCanWin =
    authMode !== "password" && authMode !== "none" && authMode !== "trusted-proxy";
  const tokenCanWin = Boolean(envToken || localToken.configured || remoteToken.configured);
  const passwordCanWin =
    authMode === "password" ||
    (authMode !== "token" && authMode !== "none" && authMode !== "trusted-proxy" && !tokenCanWin);
  const localTokenSurfaceActive =
    localTokenCanWin &&
    !envToken &&
    (authMode === "token" ||
      (authMode === undefined && !(envPassword || localPassword.configured)));

  const remoteMode = gateway?.mode === "remote";
  const remoteUrlConfigured = Boolean(trimToUndefined(remote?.url));
  const tailscaleRemoteExposure =
    gateway?.tailscale?.mode === "serve" || gateway?.tailscale?.mode === "funnel";
  const remoteEnabled = remote?.enabled !== false;
  const remoteConfiguredSurface = remoteMode || remoteUrlConfigured || tailscaleRemoteExposure;
  const remoteTokenFallbackActive = localTokenCanWin && !envToken && !localToken.configured;
  const remotePasswordFallbackActive = !envPassword && !localPassword.configured && passwordCanWin;

  return {
    configuredMode: gateway?.mode === "remote" ? "remote" : "local",
    authMode,
    envToken,
    envPassword,
    localToken,
    localPassword,
    remoteToken,
    remotePassword,
    localTokenCanWin,
    localPasswordCanWin: passwordCanWin,
    localTokenSurfaceActive,
    tokenCanWin,
    passwordCanWin,
    remoteMode,
    remoteUrlConfigured,
    tailscaleRemoteExposure,
    remoteEnabled,
    remoteConfiguredSurface,
    remoteTokenFallbackActive,
    remoteTokenActive: remoteEnabled && (remoteConfiguredSurface || remoteTokenFallbackActive),
    remotePasswordFallbackActive,
    remotePasswordActive:
      remoteEnabled && (remoteConfiguredSurface || remotePasswordFallbackActive),
  };
}
