// 网关凭据管理模块 - 处理网关认证凭据的解析和管理 / Gateway credentials management module - handles resolution and management of gateway authentication credentials

import type { OpenClawConfig } from "../config/config.js";
import {
  createGatewayCredentialPlan,
  type GatewayCredentialPlan,
  readGatewayPasswordEnv,
  readGatewayTokenEnv,
  trimCredentialToUndefined,
  trimToUndefined,
} from "./credential-planner.js";
export {
  hasGatewayPasswordEnvCandidate,
  hasGatewayTokenEnvCandidate,
  readGatewayPasswordEnv,
  readGatewayTokenEnv,
  trimCredentialToUndefined,
  trimToUndefined,
} from "./credential-planner.js";

/**
 * 显式网关认证信息 / Explicit gateway authentication info
 */
export type ExplicitGatewayAuth = {
  /** 令牌 / Token */
  token?: string;
  /** 密码 / Password */
  password?: string;
};

/**
 * 已解析的网关凭据 / Resolved gateway credentials
 */
export type ResolvedGatewayCredentials = {
  /** 令牌 / Token */
  token?: string;
  /** 密码 / Password */
  password?: string;
};

/**
 * 网关凭据模式 / Gateway credential mode
 * - local: 本地模式 / Local mode
 * - remote: 远程模式 / Remote mode
 */
export type GatewayCredentialMode = "local" | "remote";

/**
 * 网关凭据优先级 / Gateway credential precedence
 * - env-first: 环境变量优先 / Environment variables first
 * - config-first: 配置文件优先 / Configuration file first
 */
export type GatewayCredentialPrecedence = "env-first" | "config-first";

/**
 * 网关远程凭据优先级 / Gateway remote credential precedence
 * - remote-first: 远程配置优先 / Remote configuration first
 * - env-first: 环境变量优先 / Environment variables first
 */
export type GatewayRemoteCredentialPrecedence = "remote-first" | "env-first";

/**
 * 网关远程凭据回退 / Gateway remote credential fallback
 * - remote-env-local: 远程 -> 环境变量 -> 本地 / Remote -> Environment -> Local
 * - remote-only: 仅远程 / Remote only
 */
export type GatewayRemoteCredentialFallback = "remote-env-local" | "remote-only";

// 网关密钥引用不可用错误代码 / Gateway secret reference unavailable error code
const GATEWAY_SECRET_REF_UNAVAILABLE_ERROR_CODE = "GATEWAY_SECRET_REF_UNAVAILABLE"; // pragma: allowlist secret

/**
 * 网关密钥引用不可用错误 / Gateway secret reference unavailable error
 * 当配置的密钥引用在当前命令路径中不可用时抛出
 * Thrown when a configured secret reference is unavailable in the current command path
 */
export class GatewaySecretRefUnavailableError extends Error {
  /** 错误代码 / Error code */
  readonly code = GATEWAY_SECRET_REF_UNAVAILABLE_ERROR_CODE;
  /** 密钥路径 / Secret path */
  readonly path: string;

  constructor(path: string) {
    super(
      [
        // 错误信息：密钥引用不可用 / Error message: secret reference unavailable
        `${path} is configured as a secret reference but is unavailable in this command path.`,
        // 修复建议 / Fix suggestions
        "Fix: set OPENCLAW_GATEWAY_TOKEN/OPENCLAW_GATEWAY_PASSWORD, pass explicit --token/--password,",
        "or run a gateway command path that resolves secret references before credential selection.",
      ].join("\n"),
    );
    this.name = "GatewaySecretRefUnavailableError";
    this.path = path;
  }
}

/**
 * 检查是否为网关密钥引用不可用错误 / Check if it's a gateway secret reference unavailable error
 * @param error - 错误对象 / Error object
 * @param expectedPath - 预期的路径（可选）/ Expected path (optional)
 * @returns 是否为该错误 / Whether it's this error
 */
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

/**
 * 获取第一个定义的值 / Get first defined value
 * @param values - 值数组 / Array of values
 * @returns 第一个定义的值或 undefined / First defined value or undefined
 */
function firstDefined(values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    if (value) {
      return value;
    }
  }
  return undefined;
}

/**
 * 抛出未解析的网关密钥输入错误 / Throw unresolved gateway secret input error
 * @param path - 密钥路径 / Secret path
 * @throws GatewaySecretRefUnavailableError
 */
function throwUnresolvedGatewaySecretInput(path: string): never {
  throw new GatewaySecretRefUnavailableError(path);
}

/**
 * 从值解析网关凭据 / Resolve gateway credentials from values
 * 根据配置值和环境变量解析网关认证凭据
 * Resolves gateway authentication credentials based on configuration values and environment variables
 *
 * @param params - 参数对象 / Parameter object
 * @returns 已解析的凭据 / Resolved credentials
 */
export function resolveGatewayCredentialsFromValues(params: {
  /** 配置令牌 / Config token */
  configToken?: unknown;
  /** 配置密码 / Config password */
  configPassword?: unknown;
  /** 环境变量 / Environment variables */
  env?: NodeJS.ProcessEnv;
  /** 是否包含旧版环境变量 / Whether to include legacy environment variables */
  includeLegacyEnv?: boolean;
  /** 令牌优先级 / Token precedence */
  tokenPrecedence?: GatewayCredentialPrecedence;
  /** 密码优先级 / Password precedence */
  passwordPrecedence?: GatewayCredentialPrecedence;
}): ResolvedGatewayCredentials {
  const env = params.env ?? process.env;
  const includeLegacyEnv = params.includeLegacyEnv ?? true;

  // 读取环境变量中的凭据 / Read credentials from environment variables
  const envToken = readGatewayTokenEnv(env, includeLegacyEnv);
  const envPassword = readGatewayPasswordEnv(env, includeLegacyEnv);

  // 规范化配置凭据 / Normalize config credentials
  const configToken = trimCredentialToUndefined(params.configToken);
  const configPassword = trimCredentialToUndefined(params.configPassword);

  // 获取优先级设置 / Get precedence settings
  const tokenPrecedence = params.tokenPrecedence ?? "env-first";
  const passwordPrecedence = params.passwordPrecedence ?? "env-first";

  // 根据优先级解析令牌 / Resolve token based on precedence
  const token =
    tokenPrecedence === "config-first"
      ? firstDefined([configToken, envToken])
      : firstDefined([envToken, configToken]);

  // 根据优先级解析密码 / Resolve password based on precedence
  const password =
    passwordPrecedence === "config-first" // pragma: allowlist secret
      ? firstDefined([configPassword, envPassword])
      : firstDefined([envPassword, configPassword]);

  return { token, password };
}

function resolveLocalGatewayCredentials(params: {
  plan: GatewayCredentialPlan;
  env: NodeJS.ProcessEnv;
  includeLegacyEnv: boolean;
  localTokenPrecedence: GatewayCredentialPrecedence;
  localPasswordPrecedence: GatewayCredentialPrecedence;
}): ResolvedGatewayCredentials {
  const fallbackToken = params.plan.localToken.configured
    ? params.plan.localToken.value
    : params.plan.remoteToken.value;
  const fallbackPassword = params.plan.localPassword.configured
    ? params.plan.localPassword.value
    : params.plan.remotePassword.value;
  const localResolved = resolveGatewayCredentialsFromValues({
    configToken: fallbackToken,
    configPassword: fallbackPassword,
    env: params.env,
    includeLegacyEnv: params.includeLegacyEnv,
    tokenPrecedence: params.localTokenPrecedence,
    passwordPrecedence: params.localPasswordPrecedence,
  });
  const localPasswordCanWin =
    params.plan.authMode === "password" ||
    (params.plan.authMode !== "token" &&
      params.plan.authMode !== "none" &&
      params.plan.authMode !== "trusted-proxy" &&
      !localResolved.token);
  const localTokenCanWin =
    params.plan.authMode === "token" ||
    (params.plan.authMode !== "password" &&
      params.plan.authMode !== "none" &&
      params.plan.authMode !== "trusted-proxy" &&
      !localResolved.password);

  if (
    params.plan.localToken.refPath &&
    params.localTokenPrecedence === "config-first" &&
    !params.plan.localToken.value &&
    Boolean(params.plan.envToken) &&
    localTokenCanWin
  ) {
    throwUnresolvedGatewaySecretInput(params.plan.localToken.refPath);
  }
  if (
    params.plan.localPassword.refPath &&
    params.localPasswordPrecedence === "config-first" && // pragma: allowlist secret
    !params.plan.localPassword.value &&
    Boolean(params.plan.envPassword) &&
    localPasswordCanWin
  ) {
    throwUnresolvedGatewaySecretInput(params.plan.localPassword.refPath);
  }
  if (
    params.plan.localToken.refPath &&
    !localResolved.token &&
    !params.plan.envToken &&
    localTokenCanWin
  ) {
    throwUnresolvedGatewaySecretInput(params.plan.localToken.refPath);
  }
  if (
    params.plan.localPassword.refPath &&
    !localResolved.password &&
    !params.plan.envPassword &&
    localPasswordCanWin
  ) {
    throwUnresolvedGatewaySecretInput(params.plan.localPassword.refPath);
  }
  return localResolved;
}

function resolveRemoteGatewayCredentials(params: {
  plan: GatewayCredentialPlan;
  remoteTokenPrecedence: GatewayRemoteCredentialPrecedence;
  remotePasswordPrecedence: GatewayRemoteCredentialPrecedence;
  remoteTokenFallback: GatewayRemoteCredentialFallback;
  remotePasswordFallback: GatewayRemoteCredentialFallback;
}): ResolvedGatewayCredentials {
  const token =
    params.remoteTokenFallback === "remote-only"
      ? params.plan.remoteToken.value
      : params.remoteTokenPrecedence === "env-first"
        ? firstDefined([
            params.plan.envToken,
            params.plan.remoteToken.value,
            params.plan.localToken.value,
          ])
        : firstDefined([
            params.plan.remoteToken.value,
            params.plan.envToken,
            params.plan.localToken.value,
          ]);
  const password =
    params.remotePasswordFallback === "remote-only" // pragma: allowlist secret
      ? params.plan.remotePassword.value
      : params.remotePasswordPrecedence === "env-first" // pragma: allowlist secret
        ? firstDefined([
            params.plan.envPassword,
            params.plan.remotePassword.value,
            params.plan.localPassword.value,
          ])
        : firstDefined([
            params.plan.remotePassword.value,
            params.plan.envPassword,
            params.plan.localPassword.value,
          ]);
  const localTokenFallbackEnabled = params.remoteTokenFallback !== "remote-only";
  const localTokenFallback =
    params.remoteTokenFallback === "remote-only" ? undefined : params.plan.localToken.value;
  const localPasswordFallback =
    params.remotePasswordFallback === "remote-only" ? undefined : params.plan.localPassword.value; // pragma: allowlist secret

  if (
    params.plan.remoteToken.refPath &&
    !token &&
    !params.plan.envToken &&
    !localTokenFallback &&
    !password
  ) {
    throwUnresolvedGatewaySecretInput(params.plan.remoteToken.refPath);
  }
  if (
    params.plan.remotePassword.refPath &&
    !password &&
    !params.plan.envPassword &&
    !localPasswordFallback &&
    !token
  ) {
    throwUnresolvedGatewaySecretInput(params.plan.remotePassword.refPath);
  }
  if (
    params.plan.localToken.refPath &&
    localTokenFallbackEnabled &&
    !token &&
    !password &&
    !params.plan.envToken &&
    !params.plan.remoteToken.value &&
    params.plan.localTokenCanWin
  ) {
    throwUnresolvedGatewaySecretInput(params.plan.localToken.refPath);
  }

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

  const plan = createGatewayCredentialPlan({
    config: params.cfg,
    env,
    includeLegacyEnv,
  });
  const mode: GatewayCredentialMode = params.modeOverride ?? plan.configuredMode;

  const localTokenPrecedence =
    params.localTokenPrecedence ??
    (env.OPENCLAW_SERVICE_KIND === "gateway" ? "config-first" : "env-first");
  const localPasswordPrecedence = params.localPasswordPrecedence ?? "env-first";

  if (mode === "local") {
    return resolveLocalGatewayCredentials({
      plan,
      env,
      includeLegacyEnv,
      localTokenPrecedence,
      localPasswordPrecedence,
    });
  }

  const remoteTokenFallback = params.remoteTokenFallback ?? "remote-env-local";
  const remotePasswordFallback = params.remotePasswordFallback ?? "remote-env-local";
  const remoteTokenPrecedence = params.remoteTokenPrecedence ?? "remote-first";
  const remotePasswordPrecedence = params.remotePasswordPrecedence ?? "env-first";

  return resolveRemoteGatewayCredentials({
    plan,
    remoteTokenPrecedence,
    remotePasswordPrecedence,
    remoteTokenFallback,
    remotePasswordFallback,
  });
}

export function resolveGatewayProbeCredentialsFromConfig(params: {
  cfg: OpenClawConfig;
  mode: GatewayCredentialMode;
  env?: NodeJS.ProcessEnv;
  explicitAuth?: ExplicitGatewayAuth;
}): ResolvedGatewayCredentials {
  return resolveGatewayCredentialsFromConfig({
    cfg: params.cfg,
    env: params.env,
    explicitAuth: params.explicitAuth,
    modeOverride: params.mode,
    includeLegacyEnv: false,
    remoteTokenFallback: "remote-only",
  });
}

export function resolveGatewayDriftCheckCredentialsFromConfig(params: {
  cfg: OpenClawConfig;
}): ResolvedGatewayCredentials {
  return resolveGatewayCredentialsFromConfig({
    cfg: params.cfg,
    env: {} as NodeJS.ProcessEnv,
    modeOverride: "local",
    localTokenPrecedence: "config-first",
  });
}
