import type { OpenClawConfig } from "../config/config.js";
import { containsEnvVarReference } from "../config/env-substitution.js";
import { resolveSecretInputRef } from "../config/types.secrets.js";

export type ExplicitGatewayAuth = {
  token?: string;
  password?: string;
};

export type ResolvedGatewayCredentials = {
  token?: string;
  password?: string;
};

export type GatewayCredentialMode = "local" | "remote";
export type GatewayCredentialPrecedence = "env-first" | "config-first";
export type GatewayRemoteCredentialPrecedence = "remote-first" | "env-first";
export type GatewayRemoteCredentialFallback = "remote-env-local" | "remote-only";

const GATEWAY_SECRET_REF_UNAVAILABLE_ERROR_CODE = "GATEWAY_SECRET_REF_UNAVAILABLE"; // pragma: allowlist secret

export class GatewaySecretRefUnavailableError extends Error {
  readonly code = GATEWAY_SECRET_REF_UNAVAILABLE_ERROR_CODE;
  readonly path: string;

  constructor(path: string) {
    super(
      [
        `${path} is configured as a secret reference but is unavailable in this command path.`,
        "Fix: set OPENCLAW_GATEWAY_TOKEN/OPENCLAW_GATEWAY_PASSWORD, pass explicit --token/--password,",
        "or run a gateway command path that resolves secret references before credential selection.",
      ].join("\n"),
    );
    this.name = "GatewaySecretRefUnavailableError";
    this.path = path;
  }
}

export function isGatewaySecretRefUnavailableError(
  error: unknown,
  expectedPath?: string,
): error is GatewaySecretRefUnavailableError {
  if (!(error instanceof GatewaySecretRefUnavailableError)) {
    return false;
  }
  if (!expectedPath) {
    return true;
  }
  return error.path === expectedPath;
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

function firstDefined(values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    if (value) {
      return value;
    }
  }
  return undefined;
}

function throwUnresolvedGatewaySecretInput(path: string): never {
  throw new GatewaySecretRefUnavailableError(path);
}

export function readGatewayTokenEnv(
  env: NodeJS.ProcessEnv = process.env,
  includeLegacyEnv = true,
): string | undefined {
  const primary = trimToUndefined(env.OPENCLAW_GATEWAY_TOKEN);
  if (primary) {
    return primary;
  }
  if (!includeLegacyEnv) {
    return undefined;
  }
  return trimToUndefined(env.CLAWDBOT_GATEWAY_TOKEN);
}

export function readGatewayPasswordEnv(
  env: NodeJS.ProcessEnv = process.env,
  includeLegacyEnv = true,
): string | undefined {
  const primary = trimToUndefined(env.OPENCLAW_GATEWAY_PASSWORD);
  if (primary) {
    return primary;
  }
  if (!includeLegacyEnv) {
    return undefined;
  }
  return trimToUndefined(env.CLAWDBOT_GATEWAY_PASSWORD);
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

export function resolveGatewayCredentialsFromValues(params: {
  configToken?: unknown;
  configPassword?: unknown;
  env?: NodeJS.ProcessEnv;
  includeLegacyEnv?: boolean;
  tokenPrecedence?: GatewayCredentialPrecedence;
  passwordPrecedence?: GatewayCredentialPrecedence;
}): ResolvedGatewayCredentials {
  const env = params.env ?? process.env;
  const includeLegacyEnv = params.includeLegacyEnv ?? true;
  const envToken = readGatewayTokenEnv(env, includeLegacyEnv);
  const envPassword = readGatewayPasswordEnv(env, includeLegacyEnv);
  const configToken = trimCredentialToUndefined(params.configToken);
  const configPassword = trimCredentialToUndefined(params.configPassword);
  const tokenPrecedence = params.tokenPrecedence ?? "env-first";
  const passwordPrecedence = params.passwordPrecedence ?? "env-first";

  const token =
    tokenPrecedence === "config-first"
      ? firstDefined([configToken, envToken])
      : firstDefined([envToken, configToken]);
  const password =
    passwordPrecedence === "config-first" // pragma: allowlist secret
      ? firstDefined([configPassword, envPassword])
      : firstDefined([envPassword, configPassword]);

  return { token, password };
}

export function resolveGatewayCredentialsFromConfig(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  explicitAuth?: ExplicitGatewayAuth;
  urlOverride?: string;
  urlOverrideSource?: "cli" | "env";
  modeOverride?: GatewayCredentialMode;
  includeLegacyEnv?: boolean;
  localTokenPrecedence?: GatewayCredentialPrecedence;
  localPasswordPrecedence?: GatewayCredentialPrecedence;
  remoteTokenPrecedence?: GatewayRemoteCredentialPrecedence;
  remotePasswordPrecedence?: GatewayRemoteCredentialPrecedence;
  remoteTokenFallback?: GatewayRemoteCredentialFallback;
  remotePasswordFallback?: GatewayRemoteCredentialFallback;
}): ResolvedGatewayCredentials {
  const env = params.env ?? process.env;
  const includeLegacyEnv = params.includeLegacyEnv ?? true;
  const explicitToken = trimToUndefined(params.explicitAuth?.token);
  const explicitPassword = trimToUndefined(params.explicitAuth?.password);
  if (explicitToken || explicitPassword) {
    return { token: explicitToken, password: explicitPassword };
  }
  if (trimToUndefined(params.urlOverride) && params.urlOverrideSource !== "env") {
    return {};
  }
  if (trimToUndefined(params.urlOverride) && params.urlOverrideSource === "env") {
    return resolveGatewayCredentialsFromValues({
      configToken: undefined,
      configPassword: undefined,
      env,
      includeLegacyEnv,
      tokenPrecedence: "env-first",
      passwordPrecedence: "env-first", // pragma: allowlist secret
    });
  }

  const mode: GatewayCredentialMode =
    params.modeOverride ?? (params.cfg.gateway?.mode === "remote" ? "remote" : "local");
  const remote = params.cfg.gateway?.remote;
  const defaults = params.cfg.secrets?.defaults;
  const authMode = params.cfg.gateway?.auth?.mode;
  const envToken = readGatewayTokenEnv(env, includeLegacyEnv);
  const envPassword = readGatewayPasswordEnv(env, includeLegacyEnv);

  const localTokenRef = resolveSecretInputRef({
    value: params.cfg.gateway?.auth?.token,
    defaults,
  }).ref;
  const localPasswordRef = resolveSecretInputRef({
    value: params.cfg.gateway?.auth?.password,
    defaults,
  }).ref;
  const remoteTokenRef = resolveSecretInputRef({
    value: remote?.token,
    defaults,
  }).ref;
  const remotePasswordRef = resolveSecretInputRef({
    value: remote?.password,
    defaults,
  }).ref;
  const remoteToken = remoteTokenRef ? undefined : trimToUndefined(remote?.token);
  const remotePassword = remotePasswordRef ? undefined : trimToUndefined(remote?.password);
  const localToken = localTokenRef ? undefined : trimToUndefined(params.cfg.gateway?.auth?.token);
  const localPassword = localPasswordRef
    ? undefined
    : trimToUndefined(params.cfg.gateway?.auth?.password);

  const localTokenPrecedence =
    params.localTokenPrecedence ??
    (env.OPENCLAW_SERVICE_KIND === "gateway" ? "config-first" : "env-first");
  const localPasswordPrecedence = params.localPasswordPrecedence ?? "env-first";

  if (mode === "local") {
    // In local mode, prefer gateway.auth.token, but also accept gateway.remote.token
    // as a fallback for cron commands and other local gateway clients.
    // This allows users in remote mode to use a single token for all operations.
    const fallbackToken = localToken ?? remoteToken;
    const fallbackPassword = localPassword ?? remotePassword;
    const localResolved = resolveGatewayCredentialsFromValues({
      configToken: fallbackToken,
      configPassword: fallbackPassword,
      env,
      includeLegacyEnv,
      tokenPrecedence: localTokenPrecedence,
      passwordPrecedence: localPasswordPrecedence,
    });
    const localPasswordCanWin =
      authMode === "password" ||
      (authMode !== "token" &&
        authMode !== "none" &&
        authMode !== "trusted-proxy" &&
        !localResolved.token);
    const localTokenCanWin =
      authMode === "token" ||
      (authMode !== "password" &&
        authMode !== "none" &&
        authMode !== "trusted-proxy" &&
        !localResolved.password);
    if (
      localTokenRef &&
      localTokenPrecedence === "config-first" &&
      !localToken &&
      Boolean(envToken) &&
      localTokenCanWin
    ) {
      throwUnresolvedGatewaySecretInput("gateway.auth.token");
    }
    if (
      localPasswordRef &&
      localPasswordPrecedence === "config-first" &&
      !localPassword &&
      Boolean(envPassword) &&
      localPasswordCanWin
    ) {
      throwUnresolvedGatewaySecretInput("gateway.auth.password");
    }
    if (localTokenRef && !localResolved.token && !envToken && localTokenCanWin) {
      throwUnresolvedGatewaySecretInput("gateway.auth.token");
    }
    if (localPasswordRef && !localResolved.password && !envPassword && localPasswordCanWin) {
      throwUnresolvedGatewaySecretInput("gateway.auth.password");
    }
    return localResolved;
  }

  const remoteTokenFallback = params.remoteTokenFallback ?? "remote-env-local";
  const remotePasswordFallback = params.remotePasswordFallback ?? "remote-env-local";
  const remoteTokenPrecedence = params.remoteTokenPrecedence ?? "remote-first";
  const remotePasswordPrecedence = params.remotePasswordPrecedence ?? "env-first";

  const token =
    remoteTokenFallback === "remote-only"
      ? remoteToken
      : remoteTokenPrecedence === "env-first"
        ? firstDefined([envToken, remoteToken, localToken])
        : firstDefined([remoteToken, envToken, localToken]);
  const password =
    remotePasswordFallback === "remote-only" // pragma: allowlist secret
      ? remotePassword
      : remotePasswordPrecedence === "env-first" // pragma: allowlist secret
        ? firstDefined([envPassword, remotePassword, localPassword])
        : firstDefined([remotePassword, envPassword, localPassword]);

  const localTokenCanWin =
    authMode === "token" ||
    (authMode !== "password" && authMode !== "none" && authMode !== "trusted-proxy");
  const localTokenFallbackEnabled = remoteTokenFallback !== "remote-only";
  const localTokenFallback = remoteTokenFallback === "remote-only" ? undefined : localToken;
  const localPasswordFallback =
    remotePasswordFallback === "remote-only" ? undefined : localPassword; // pragma: allowlist secret
  if (remoteTokenRef && !token && !envToken && !localTokenFallback && !password) {
    throwUnresolvedGatewaySecretInput("gateway.remote.token");
  }
  if (remotePasswordRef && !password && !envPassword && !localPasswordFallback && !token) {
    throwUnresolvedGatewaySecretInput("gateway.remote.password");
  }
  if (
    localTokenRef &&
    localTokenFallbackEnabled &&
    !token &&
    !password &&
    !envToken &&
    !remoteToken &&
    localTokenCanWin
  ) {
    throwUnresolvedGatewaySecretInput("gateway.auth.token");
  }

  return { token, password };
}
