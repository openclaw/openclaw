import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  createGatewayCredentialPlan,
  type GatewayCredentialPlan,
  trimCredentialToUndefined,
  trimToUndefined,
} from "./credential-planner.js";
export { trimToUndefined } from "./credential-planner.js";

export type ExplicitGatewayAuth = {
  token?: string;
  password?: string;
};

/** Trim caller-supplied Gateway credentials without consulting config or environment. */
export function resolveExplicitGatewayAuth(auth?: ExplicitGatewayAuth): ExplicitGatewayAuth {
  return {
    token: trimToUndefined(auth?.token),
    password: trimToUndefined(auth?.password),
  };
}

export type GatewayCredentialMode = "local" | "remote";

export type GatewayCredentialPrecedence = "env-first" | "config-first";

export type GatewayRemoteCredentialPrecedence = "remote-first" | "env-first";

export type GatewayRemoteCredentialFallback = "remote-env-local" | "remote-only";

const GATEWAY_SECRET_REF_UNAVAILABLE_ERROR_CODE = "GATEWAY_SECRET_REF_UNAVAILABLE"; // pragma: allowlist secret

/** Raised when a command path needs Gateway credentials before secret refs were resolved. */
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
  return (
    error instanceof GatewaySecretRefUnavailableError &&
    (!expectedPath || error.path === expectedPath)
  );
}

export function resolveGatewayCredentialsFromValues(params: {
  configToken?: unknown;
  configPassword?: unknown;
  env?: NodeJS.ProcessEnv;
  tokenPrecedence?: GatewayCredentialPrecedence;
  passwordPrecedence?: GatewayCredentialPrecedence;
}): ExplicitGatewayAuth {
  const env = params.env ?? process.env;
  const envToken = trimToUndefined(env.OPENCLAW_GATEWAY_TOKEN);
  const envPassword = trimToUndefined(env.OPENCLAW_GATEWAY_PASSWORD);
  const configToken = trimCredentialToUndefined(params.configToken);
  const configPassword = trimCredentialToUndefined(params.configPassword);
  const tokenPrecedence = params.tokenPrecedence ?? "env-first";
  const passwordPrecedence = params.passwordPrecedence ?? "env-first";

  const token =
    tokenPrecedence === "config-first" ? configToken || envToken : envToken || configToken;
  const password =
    passwordPrecedence === "config-first" // pragma: allowlist secret
      ? configPassword || envPassword
      : envPassword || configPassword;

  return { token, password };
}

function resolveLocalGatewayCredentials(params: {
  plan: GatewayCredentialPlan;
  localPrecedence: GatewayCredentialPrecedence;
}): ExplicitGatewayAuth {
  const { plan, localPrecedence } = params;
  const resolveCredential = (
    credential: GatewayCredentialPlan["localToken"],
    envValue: string | undefined,
    fallback: string | undefined,
  ) => {
    const configFallback = credential.configured ? credential.value : fallback;
    return localPrecedence === "config-first"
      ? credential.value || envValue || (credential.configured ? undefined : fallback)
      : envValue || configFallback;
  };
  const token = resolveCredential(plan.localToken, plan.envToken, plan.remoteToken.value);
  const password = resolveCredential(
    plan.localPassword,
    plan.envPassword,
    plan.authMode === "trusted-proxy" ? undefined : plan.remotePassword.value,
  );
  const localResolved = { token, password };
  const localPasswordCanWin =
    params.plan.authMode === "password" ||
    params.plan.authMode === "trusted-proxy" ||
    (params.plan.authMode !== "token" && params.plan.authMode !== "none" && !localResolved.token);
  const localTokenCanWin =
    params.plan.authMode === "token" ||
    (params.plan.authMode !== "password" &&
      params.plan.authMode !== "none" &&
      params.plan.authMode !== "trusted-proxy" &&
      !localResolved.password);

  const candidates = [
    { credential: plan.localToken, env: plan.envToken, value: token, canWin: localTokenCanWin },
    {
      credential: plan.localPassword,
      env: plan.envPassword,
      value: password,
      canWin: localPasswordCanWin,
    },
  ].filter(({ credential, canWin }) => credential.refPath && canWin);
  // Config-first callers must not let an env fallback mask a configured but
  // unresolved secret ref. Preserve that diagnostic ahead of missing-value errors.
  const unresolved =
    (localPrecedence === "config-first"
      ? candidates.find(({ credential, env }) => !credential.value && Boolean(env))
      : undefined) ?? candidates.find(({ value, env }) => !value && !env);
  if (unresolved?.credential.refPath) {
    throw new GatewaySecretRefUnavailableError(unresolved.credential.refPath);
  }
  return localResolved;
}

export function resolveGatewayCredentialsFromConfig(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  explicitAuth?: ExplicitGatewayAuth;
  urlOverride?: string;
  urlOverrideSource?: "cli" | "env";
  modeOverride?: GatewayCredentialMode;
  localPrecedence?: GatewayCredentialPrecedence;
  remoteTokenPrecedence?: GatewayRemoteCredentialPrecedence;
  remotePasswordPrecedence?: GatewayRemoteCredentialPrecedence;
  remoteTokenFallback?: GatewayRemoteCredentialFallback;
  remotePasswordFallback?: GatewayRemoteCredentialFallback;
}): ExplicitGatewayAuth {
  const env = params.env ?? process.env;
  const explicitAuth = resolveExplicitGatewayAuth(params.explicitAuth);
  if (explicitAuth.token || explicitAuth.password) {
    return explicitAuth;
  }
  // Ad-hoc URLs cannot reuse configured credentials. Env overrides retain only
  // credentials from the same environment; CLI overrides need explicit auth.
  if (trimToUndefined(params.urlOverride)) {
    return params.urlOverrideSource === "env" ? resolveGatewayCredentialsFromValues({ env }) : {};
  }

  const plan = createGatewayCredentialPlan({
    config: params.cfg,
    env,
  });
  const mode: GatewayCredentialMode = params.modeOverride ?? plan.configuredMode;

  if (mode === "local") {
    return resolveLocalGatewayCredentials({
      plan,
      localPrecedence: params.localPrecedence ?? "config-first",
    });
  }

  const remoteTokenFallback = params.remoteTokenFallback ?? "remote-env-local";
  const remotePasswordFallback = params.remotePasswordFallback ?? "remote-env-local";
  const remoteTokenPrecedence = params.remoteTokenPrecedence ?? "remote-first";
  const remotePasswordPrecedence = params.remotePasswordPrecedence ?? "env-first";

  const resolveCredential = (kind: "Token" | "Password") => {
    const remote = plan[`remote${kind}`].value;
    if ((kind === "Token" ? remoteTokenFallback : remotePasswordFallback) === "remote-only") {
      return remote;
    }
    const envCredential = plan[`env${kind}`];
    const local = plan[`local${kind}`].value;
    return (kind === "Token" ? remoteTokenPrecedence : remotePasswordPrecedence) === "env-first"
      ? envCredential || remote || local
      : remote || envCredential || local;
  };
  const token = resolveCredential("Token");
  const password = resolveCredential("Password");
  const localTokenFallbackEnabled = remoteTokenFallback !== "remote-only";
  const localTokenFallback =
    remoteTokenFallback === "remote-only" ? undefined : plan.localToken.value;
  const localPasswordFallback =
    remotePasswordFallback === "remote-only" ? undefined : plan.localPassword.value; // pragma: allowlist secret

  // Remote-only probe paths intentionally ignore local fallback credentials;
  // normal remote clients keep them as a last resort for older local config.
  if (plan.remoteToken.refPath && !token && !plan.envToken && !localTokenFallback && !password) {
    throw new GatewaySecretRefUnavailableError(plan.remoteToken.refPath);
  }
  if (
    plan.remotePassword.refPath &&
    !password &&
    !plan.envPassword &&
    !localPasswordFallback &&
    !token
  ) {
    throw new GatewaySecretRefUnavailableError(plan.remotePassword.refPath);
  }
  if (
    plan.localToken.refPath &&
    localTokenFallbackEnabled &&
    !token &&
    !password &&
    !plan.envToken &&
    !plan.remoteToken.value &&
    plan.localTokenCanWin
  ) {
    throw new GatewaySecretRefUnavailableError(plan.localToken.refPath);
  }

  return { token, password };
}

/** Resolve the stricter credential view used by Gateway probe paths. */
export function resolveGatewayProbeCredentialsFromConfig(params: {
  cfg: OpenClawConfig;
  mode: GatewayCredentialMode;
  env?: NodeJS.ProcessEnv;
  explicitAuth?: ExplicitGatewayAuth;
  urlOverride?: string;
  urlOverrideSource?: "cli" | "env";
}): ExplicitGatewayAuth {
  return resolveGatewayCredentialsFromConfig({
    cfg: params.cfg,
    env: params.env,
    explicitAuth: params.explicitAuth,
    urlOverride: params.urlOverride,
    urlOverrideSource: params.urlOverrideSource,
    modeOverride: params.mode,
    remoteTokenFallback: "remote-only",
  });
}
