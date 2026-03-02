import type { OpenClawConfig } from "../config/config.js";
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

export function trimToUndefined(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
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
  throw new Error(
    [
      `${path} is configured as a secret reference but is unavailable in this command path.`,
      "Fix: set OPENCLAW_GATEWAY_TOKEN/OPENCLAW_GATEWAY_PASSWORD, pass explicit --token/--password,",
      "or run a gateway command path that resolves secret references before credential selection.",
    ].join("\n"),
  );
}

function readGatewayTokenEnv(
  env: NodeJS.ProcessEnv,
  includeLegacyEnv: boolean,
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

function readGatewayPasswordEnv(
  env: NodeJS.ProcessEnv,
  includeLegacyEnv: boolean,
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
  const configToken = trimToUndefined(params.configToken);
  const configPassword = trimToUndefined(params.configPassword);
  const tokenPrecedence = params.tokenPrecedence ?? "env-first";
  const passwordPrecedence = params.passwordPrecedence ?? "env-first";

  const token =
    tokenPrecedence === "config-first"
      ? firstDefined([configToken, envToken])
      : firstDefined([envToken, configToken]);
  const password =
    passwordPrecedence === "config-first"
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
      passwordPrecedence: "env-first",
    });
  }

  const mode: GatewayCredentialMode =
    params.modeOverride ?? (params.cfg.gateway?.mode === "remote" ? "remote" : "local");
  const remote = params.cfg.gateway?.remote;
  const defaults = params.cfg.secrets?.defaults;
  const authMode = params.cfg.gateway?.auth?.mode;
  const envToken = readGatewayTokenEnv(env, includeLegacyEnv);
  const envPassword = readGatewayPasswordEnv(env, includeLegacyEnv);

  const remoteToken = trimToUndefined(remote?.token);
  const remotePassword = trimToUndefined(remote?.password);
  const localToken = trimToUndefined(params.cfg.gateway?.auth?.token);
  const localPassword = trimToUndefined(params.cfg.gateway?.auth?.password);

  const localTokenPrecedence = params.localTokenPrecedence ?? "env-first";
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
    const localPasswordRef = resolveSecretInputRef({
      value: params.cfg.gateway?.auth?.password,
      defaults,
    }).ref;
    if (
      localPasswordRef &&
      !localResolved.password &&
      !envPassword &&
      (authMode === "password" || !localResolved.token)
    ) {
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
    remotePasswordFallback === "remote-only"
      ? remotePassword
      : remotePasswordPrecedence === "env-first"
        ? firstDefined([envPassword, remotePassword, localPassword])
        : firstDefined([remotePassword, envPassword, localPassword]);

  const remoteTokenRef = resolveSecretInputRef({
    value: remote?.token,
    defaults,
  }).ref;
  const remotePasswordRef = resolveSecretInputRef({
    value: remote?.password,
    defaults,
  }).ref;
  const localTokenFallback = remoteTokenFallback === "remote-only" ? undefined : localToken;
  const localPasswordFallback =
    remotePasswordFallback === "remote-only" ? undefined : localPassword;
  if (remoteTokenRef && !token && !envToken && !localTokenFallback && !password) {
    throwUnresolvedGatewaySecretInput("gateway.remote.token");
  }
  if (remotePasswordRef && !password && !envPassword && !localPasswordFallback && !token) {
    throwUnresolvedGatewaySecretInput("gateway.remote.password");
  }

  return { token, password };
}
