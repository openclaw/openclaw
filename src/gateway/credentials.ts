import type { OpenClawConfig } from "../config/config.js";

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
  configToken?: string;
  configPassword?: string;
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
  if (trimToUndefined(params.urlOverride)) {
    return {};
  }

  const mode: GatewayCredentialMode =
    params.modeOverride ?? (params.cfg.gateway?.mode === "remote" ? "remote" : "local");
  const remote = mode === "remote" ? params.cfg.gateway?.remote : undefined;
  const envToken = readGatewayTokenEnv(env, includeLegacyEnv);
  const envPassword = readGatewayPasswordEnv(env, includeLegacyEnv);

  const remoteToken = trimToUndefined(remote?.token);
  const remotePassword = trimToUndefined(remote?.password);
  const localToken = trimToUndefined(params.cfg.gateway?.auth?.token);
  const localPassword = trimToUndefined(params.cfg.gateway?.auth?.password);

  const localTokenPrecedence = params.localTokenPrecedence ?? "env-first";
  const localPasswordPrecedence = params.localPasswordPrecedence ?? "env-first";

  if (mode === "local") {
    const localResolved = resolveGatewayCredentialsFromValues({
      configToken: localToken,
      configPassword: localPassword,
      env,
      includeLegacyEnv,
      tokenPrecedence: localTokenPrecedence,
      passwordPrecedence: localPasswordPrecedence,
    });
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

  return { token, password };
}
