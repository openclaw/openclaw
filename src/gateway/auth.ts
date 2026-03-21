// 网关认证模块 - 处理网关连接的身份验证和授权 / Gateway authentication module - handles authentication and authorization for gateway connections

import type { IncomingMessage } from "node:http";
import type {
  GatewayAuthConfig,
  GatewayTailscaleMode,
  GatewayTrustedProxyConfig,
} from "../config/config.js";
import { resolveSecretInputRef } from "../config/types.secrets.js";
import { readTailscaleWhoisIdentity, type TailscaleWhoisIdentity } from "../infra/tailscale.js";
import { safeEqualSecret } from "../security/secret-equal.js";
import {
  AUTH_RATE_LIMIT_SCOPE_SHARED_SECRET,
  type AuthRateLimiter,
  type RateLimitCheckResult,
} from "./auth-rate-limit.js";
import { resolveGatewayCredentialsFromValues } from "./credentials.js";
import {
  isLocalishHost,
  isLoopbackAddress,
  resolveRequestClientIp,
  isTrustedProxyAddress,
  resolveClientIp,
} from "./net.js";

/**
 * 已解析的网关认证模式 / Resolved gateway authentication mode
 * - none: 无认证 / No authentication
 * - token: 令牌认证 / Token authentication
 * - password: 密码认证 / Password authentication
 * - trusted-proxy: 可信代理认证 / Trusted proxy authentication
 */
export type ResolvedGatewayAuthMode = "none" | "token" | "password" | "trusted-proxy";

/**
 * 已解析的网关认证模式来源 / Resolved gateway authentication mode source
 * - override: 覆盖配置 / Override configuration
 * - config: 配置文件 / Configuration file
 * - password: 密码 / Password
 * - token: 令牌 / Token
 * - default: 默认值 / Default value
 */
export type ResolvedGatewayAuthModeSource =
  | "override"
  | "config"
  | "password"
  | "token"
  | "default";

/**
 * 已解析的网关认证配置 / Resolved gateway authentication configuration
 */
export type ResolvedGatewayAuth = {
  /** 认证模式 / Authentication mode */
  mode: ResolvedGatewayAuthMode;
  /** 模式来源 / Mode source */
  modeSource?: ResolvedGatewayAuthModeSource;
  /** 认证令牌 / Authentication token */
  token?: string;
  /** 认证密码 / Authentication password */
  password?: string;
  /** 是否允许 Tailscale 认证 / Whether to allow Tailscale authentication */
  allowTailscale: boolean;
  /** 可信代理配置 / Trusted proxy configuration */
  trustedProxy?: GatewayTrustedProxyConfig;
};

/**
 * 网关认证结果 / Gateway authentication result
 */
export type GatewayAuthResult = {
  /** 认证是否成功 / Whether authentication succeeded */
  ok: boolean;
  /** 认证方法 / Authentication method */
  method?:
    | "none"
    | "token"
    | "password"
    | "tailscale"
    | "device-token"
    | "bootstrap-token"
    | "trusted-proxy";
  /** 用户标识 / User identifier */
  user?: string;
  /** 失败原因 / Failure reason */
  reason?: string;
  /** 当请求被速率限制器阻止时存在 / Present when the request was blocked by the rate limiter */
  rateLimited?: boolean;
  /** 客户端应等待的毫秒数（当被速率限制时）/ Milliseconds the client should wait before retrying (when rate-limited) */
  retryAfterMs?: number;
};

/**
 * 连接认证信息 / Connection authentication info
 */
type ConnectAuth = {
  /** 令牌 / Token */
  token?: string;
  /** 密码 / Password */
  password?: string;
};

/**
 * 网关认证表面 / Gateway authentication surface
 * - http: HTTP 认证 / HTTP authentication
 * - ws-control-ui: WebSocket 控制界面认证 / WebSocket control UI authentication
 */
export type GatewayAuthSurface = "http" | "ws-control-ui";

/**
 * 授权网关连接参数 / Authorize gateway connection parameters
 */
export type AuthorizeGatewayConnectParams = {
  /** 已解析的认证配置 / Resolved authentication configuration */
  auth: ResolvedGatewayAuth;
  /** 连接认证信息 / Connection authentication info */
  connectAuth?: ConnectAuth | null;
  /** HTTP 请求对象 / HTTP request object */
  req?: IncomingMessage;
  /** 可信代理列表 / Trusted proxies list */
  trustedProxies?: string[];
  /** Tailscale whois 查询函数 / Tailscale whois lookup function */
  tailscaleWhois?: TailscaleWhoisLookup;
  /**
   * 显式认证表面 / Explicit auth surface
   * HTTP 保持 Tailscale 转发头部认证禁用 / HTTP keeps Tailscale forwarded-header auth disabled
   * WS 控制界面有意启用它以实现无令牌的可信主机登录 / WS Control UI enables it intentionally for tokenless trusted-host login
   */
  authSurface?: GatewayAuthSurface;
  /** 可选的速率限制器实例；当提供时，失败的尝试会按 IP 跟踪 / Optional rate limiter instance; when provided, failed attempts are tracked per IP */
  rateLimiter?: AuthRateLimiter;
  /** 用于速率限制跟踪的客户端 IP；回退到代理感知的请求 IP 解析 / Client IP used for rate-limit tracking; falls back to proxy-aware request IP resolution */
  clientIp?: string;
  /** 可选的限制器范围；默认为共享密钥认证范围 / Optional limiter scope; defaults to shared-secret auth scope */
  rateLimitScope?: string;
  /** 仅在显式启用时信任 X-Real-IP / Trust X-Real-IP only when explicitly enabled */
  allowRealIpFallback?: boolean;
};

type TailscaleUser = {
  login: string;
  name: string;
  profilePic?: string;
};

type TailscaleWhoisLookup = (ip: string) => Promise<TailscaleWhoisIdentity | null>;

/**
 * 规范化登录名 / Normalize login name
 * @param login - 原始登录名 / Original login name
 * @returns 规范化后的登录名 / Normalized login name
 */
function normalizeLogin(login: string): string {
  return login.trim().toLowerCase();
}

/**
 * 获取头部值 / Get header value
 * @param value - 头部值（可能是字符串或数组）/ Header value (may be string or array)
 * @returns 头部值 / Header value
 */
function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

const TAILSCALE_TRUSTED_PROXIES = ["127.0.0.1", "::1"] as const;

function resolveTailscaleClientIp(req?: IncomingMessage): string | undefined {
  if (!req) {
    return undefined;
  }
  return resolveClientIp({
    remoteAddr: req.socket?.remoteAddress ?? "",
    forwardedFor: headerValue(req.headers?.["x-forwarded-for"]),
    trustedProxies: [...TAILSCALE_TRUSTED_PROXIES],
  });
}

/**
 * 检查是否为本地直接请求 / Check if it's a local direct request
 * @param req - HTTP 请求对象 / HTTP request object
 * @param trustedProxies - 可信代理列表 / Trusted proxies list
 * @param allowRealIpFallback - 是否允许 X-Real-IP 回退 / Whether to allow X-Real-IP fallback
 * @returns 是否为本地直接请求 / Whether it's a local direct request
 */
export function isLocalDirectRequest(
  req?: IncomingMessage,
  trustedProxies?: string[],
  allowRealIpFallback = false,
): boolean {
  if (!req) {
    return false;
  }
  const clientIp = resolveRequestClientIp(req, trustedProxies, allowRealIpFallback) ?? "";
  if (!isLoopbackAddress(clientIp)) {
    return false;
  }

  // 检查是否有转发头部 / Check if there are forwarded headers
  const hasForwarded = Boolean(
    req.headers?.["x-forwarded-for"] ||
    req.headers?.["x-real-ip"] ||
    req.headers?.["x-forwarded-host"],
  );

  const remoteIsTrustedProxy = isTrustedProxyAddress(req.socket?.remoteAddress, trustedProxies);
  return isLocalishHost(req.headers?.host) && (!hasForwarded || remoteIsTrustedProxy);
}

function getTailscaleUser(req?: IncomingMessage): TailscaleUser | null {
  if (!req) {
    return null;
  }
  const login = req.headers["tailscale-user-login"];
  if (typeof login !== "string" || !login.trim()) {
    return null;
  }
  const nameRaw = req.headers["tailscale-user-name"];
  const profilePic = req.headers["tailscale-user-profile-pic"];
  const name = typeof nameRaw === "string" && nameRaw.trim() ? nameRaw.trim() : login.trim();
  return {
    login: login.trim(),
    name,
    profilePic: typeof profilePic === "string" && profilePic.trim() ? profilePic.trim() : undefined,
  };
}

function hasTailscaleProxyHeaders(req?: IncomingMessage): boolean {
  if (!req) {
    return false;
  }
  return Boolean(
    req.headers["x-forwarded-for"] &&
    req.headers["x-forwarded-proto"] &&
    req.headers["x-forwarded-host"],
  );
}

function isTailscaleProxyRequest(req?: IncomingMessage): boolean {
  if (!req) {
    return false;
  }
  return isLoopbackAddress(req.socket?.remoteAddress) && hasTailscaleProxyHeaders(req);
}

async function resolveVerifiedTailscaleUser(params: {
  req?: IncomingMessage;
  tailscaleWhois: TailscaleWhoisLookup;
}): Promise<{ ok: true; user: TailscaleUser } | { ok: false; reason: string }> {
  const { req, tailscaleWhois } = params;
  const tailscaleUser = getTailscaleUser(req);
  if (!tailscaleUser) {
    return { ok: false, reason: "tailscale_user_missing" };
  }
  if (!isTailscaleProxyRequest(req)) {
    return { ok: false, reason: "tailscale_proxy_missing" };
  }
  const clientIp = resolveTailscaleClientIp(req);
  if (!clientIp) {
    return { ok: false, reason: "tailscale_whois_failed" };
  }
  const whois = await tailscaleWhois(clientIp);
  if (!whois?.login) {
    return { ok: false, reason: "tailscale_whois_failed" };
  }
  if (normalizeLogin(whois.login) !== normalizeLogin(tailscaleUser.login)) {
    return { ok: false, reason: "tailscale_user_mismatch" };
  }
  return {
    ok: true,
    user: {
      login: whois.login,
      name: whois.name ?? tailscaleUser.name,
      profilePic: tailscaleUser.profilePic,
    },
  };
}

/**
 * 解析网关认证配置 / Resolve gateway authentication configuration
 * @param params - 参数对象 / Parameter object
 * @returns 已解析的认证配置 / Resolved authentication configuration
 */
export function resolveGatewayAuth(params: {
  /** 认证配置 / Authentication configuration */
  authConfig?: GatewayAuthConfig | null;
  /** 认证覆盖配置 / Authentication override configuration */
  authOverride?: GatewayAuthConfig | null;
  /** 环境变量 / Environment variables */
  env?: NodeJS.ProcessEnv;
  /** Tailscale 模式 / Tailscale mode */
  tailscaleMode?: GatewayTailscaleMode;
}): ResolvedGatewayAuth {
  const baseAuthConfig = params.authConfig ?? {};
  const authOverride = params.authOverride ?? undefined;
  const authConfig: GatewayAuthConfig = { ...baseAuthConfig };

  // 应用覆盖配置 / Apply override configuration
  if (authOverride) {
    if (authOverride.mode !== undefined) {
      authConfig.mode = authOverride.mode;
    }
    if (authOverride.token !== undefined) {
      authConfig.token = authOverride.token;
    }
    if (authOverride.password !== undefined) {
      authConfig.password = authOverride.password;
    }
    if (authOverride.allowTailscale !== undefined) {
      authConfig.allowTailscale = authOverride.allowTailscale;
    }
    if (authOverride.rateLimit !== undefined) {
      authConfig.rateLimit = authOverride.rateLimit;
    }
    if (authOverride.trustedProxy !== undefined) {
      authConfig.trustedProxy = authOverride.trustedProxy;
    }
  }

  const env = params.env ?? process.env;
  const tokenRef = resolveSecretInputRef({ value: authConfig.token }).ref;
  const passwordRef = resolveSecretInputRef({ value: authConfig.password }).ref;

  // 解析凭据 / Resolve credentials
  const resolvedCredentials = resolveGatewayCredentialsFromValues({
    configToken: tokenRef ? undefined : authConfig.token,
    configPassword: passwordRef ? undefined : authConfig.password,
    env,
    includeLegacyEnv: false,
    tokenPrecedence: "config-first",
    passwordPrecedence: "config-first", // pragma: allowlist secret
  });

  const token = resolvedCredentials.token;
  const password = resolvedCredentials.password;
  const trustedProxy = authConfig.trustedProxy;

  // 确定认证模式和来源 / Determine authentication mode and source
  let mode: ResolvedGatewayAuth["mode"];
  let modeSource: ResolvedGatewayAuth["modeSource"];

  if (authOverride?.mode !== undefined) {
    mode = authOverride.mode;
    modeSource = "override";
  } else if (authConfig.mode) {
    mode = authConfig.mode;
    modeSource = "config";
  } else if (password) {
    mode = "password";
    modeSource = "password";
  } else if (token) {
    mode = "token";
    modeSource = "token";
  } else {
    mode = "token";
    modeSource = "default";
  }

  // 确定 Tailscale 是否允许 / Determine if Tailscale is allowed
  const allowTailscale =
    authConfig.allowTailscale ??
    (params.tailscaleMode === "serve" && mode !== "password" && mode !== "trusted-proxy");

  return {
    mode,
    modeSource,
    token,
    password,
    allowTailscale,
    trustedProxy,
  };
}

export function assertGatewayAuthConfigured(
  auth: ResolvedGatewayAuth,
  rawAuthConfig?: GatewayAuthConfig | null,
): void {
  if (auth.mode === "token" && !auth.token) {
    if (auth.allowTailscale) {
      return;
    }
    throw new Error(
      "gateway auth mode is token, but no token was configured (set gateway.auth.token or OPENCLAW_GATEWAY_TOKEN)",
    );
  }
  if (auth.mode === "password" && !auth.password) {
    if (
      rawAuthConfig?.password != null && // pragma: allowlist secret
      typeof rawAuthConfig.password !== "string" // pragma: allowlist secret
    ) {
      throw new Error(
        "gateway auth mode is password, but gateway.auth.password contains a provider reference object instead of a resolved string — bootstrap secrets (gateway.auth.password) must be plaintext strings or set via the OPENCLAW_GATEWAY_PASSWORD environment variable because the secrets provider system has not initialised yet at gateway startup", // pragma: allowlist secret
      );
    }
    throw new Error("gateway auth mode is password, but no password was configured");
  }
  if (auth.mode === "trusted-proxy") {
    if (!auth.trustedProxy) {
      throw new Error(
        "gateway auth mode is trusted-proxy, but no trustedProxy config was provided (set gateway.auth.trustedProxy)",
      );
    }
    if (!auth.trustedProxy.userHeader || auth.trustedProxy.userHeader.trim() === "") {
      throw new Error(
        "gateway auth mode is trusted-proxy, but trustedProxy.userHeader is empty (set gateway.auth.trustedProxy.userHeader)",
      );
    }
  }
}

/**
 * Check if the request came from a trusted proxy and extract user identity.
 * Returns the user identity if valid, or null with a reason if not.
 */
function authorizeTrustedProxy(params: {
  req?: IncomingMessage;
  trustedProxies?: string[];
  trustedProxyConfig: GatewayTrustedProxyConfig;
}): { user: string } | { reason: string } {
  const { req, trustedProxies, trustedProxyConfig } = params;

  if (!req) {
    return { reason: "trusted_proxy_no_request" };
  }

  const remoteAddr = req.socket?.remoteAddress;
  if (!remoteAddr || !isTrustedProxyAddress(remoteAddr, trustedProxies)) {
    return { reason: "trusted_proxy_untrusted_source" };
  }

  const requiredHeaders = trustedProxyConfig.requiredHeaders ?? [];
  for (const header of requiredHeaders) {
    const value = headerValue(req.headers[header.toLowerCase()]);
    if (!value || value.trim() === "") {
      return { reason: `trusted_proxy_missing_header_${header}` };
    }
  }

  const userHeaderValue = headerValue(req.headers[trustedProxyConfig.userHeader.toLowerCase()]);
  if (!userHeaderValue || userHeaderValue.trim() === "") {
    return { reason: "trusted_proxy_user_missing" };
  }

  const user = userHeaderValue.trim();

  const allowUsers = trustedProxyConfig.allowUsers ?? [];
  if (allowUsers.length > 0 && !allowUsers.includes(user)) {
    return { reason: "trusted_proxy_user_not_allowed" };
  }

  return { user };
}

function shouldAllowTailscaleHeaderAuth(authSurface: GatewayAuthSurface): boolean {
  return authSurface === "ws-control-ui";
}

export async function authorizeGatewayConnect(
  params: AuthorizeGatewayConnectParams,
): Promise<GatewayAuthResult> {
  const { auth, connectAuth, req, trustedProxies } = params;
  const tailscaleWhois = params.tailscaleWhois ?? readTailscaleWhoisIdentity;
  const authSurface = params.authSurface ?? "http";
  const allowTailscaleHeaderAuth = shouldAllowTailscaleHeaderAuth(authSurface);
  const localDirect = isLocalDirectRequest(
    req,
    trustedProxies,
    params.allowRealIpFallback === true,
  );

  if (auth.mode === "trusted-proxy") {
    if (!auth.trustedProxy) {
      return { ok: false, reason: "trusted_proxy_config_missing" };
    }
    if (!trustedProxies || trustedProxies.length === 0) {
      return { ok: false, reason: "trusted_proxy_no_proxies_configured" };
    }

    const result = authorizeTrustedProxy({
      req,
      trustedProxies,
      trustedProxyConfig: auth.trustedProxy,
    });

    if ("user" in result) {
      return { ok: true, method: "trusted-proxy", user: result.user };
    }
    return { ok: false, reason: result.reason };
  }

  if (auth.mode === "none") {
    return { ok: true, method: "none" };
  }

  const limiter = params.rateLimiter;
  const ip =
    params.clientIp ??
    resolveRequestClientIp(req, trustedProxies, params.allowRealIpFallback === true) ??
    req?.socket?.remoteAddress;
  const rateLimitScope = params.rateLimitScope ?? AUTH_RATE_LIMIT_SCOPE_SHARED_SECRET;
  if (limiter) {
    const rlCheck: RateLimitCheckResult = limiter.check(ip, rateLimitScope);
    if (!rlCheck.allowed) {
      return {
        ok: false,
        reason: "rate_limited",
        rateLimited: true,
        retryAfterMs: rlCheck.retryAfterMs,
      };
    }
  }

  if (allowTailscaleHeaderAuth && auth.allowTailscale && !localDirect) {
    const tailscaleCheck = await resolveVerifiedTailscaleUser({
      req,
      tailscaleWhois,
    });
    if (tailscaleCheck.ok) {
      limiter?.reset(ip, rateLimitScope);
      return {
        ok: true,
        method: "tailscale",
        user: tailscaleCheck.user.login,
      };
    }
  }

  if (auth.mode === "token") {
    if (!auth.token) {
      return { ok: false, reason: "token_missing_config" };
    }
    if (!connectAuth?.token) {
      // Don't burn rate-limit slots for missing credentials — the client
      // simply hasn't provided a token yet (e.g. bare browser open).
      // Only actual *wrong* credentials should count as failures.
      return { ok: false, reason: "token_missing" };
    }
    if (!safeEqualSecret(connectAuth.token, auth.token)) {
      limiter?.recordFailure(ip, rateLimitScope);
      return { ok: false, reason: "token_mismatch" };
    }
    limiter?.reset(ip, rateLimitScope);
    return { ok: true, method: "token" };
  }

  if (auth.mode === "password") {
    const password = connectAuth?.password;
    if (!auth.password) {
      return { ok: false, reason: "password_missing_config" };
    }
    if (!password) {
      // Same as token_missing — don't penalize absent credentials.
      return { ok: false, reason: "password_missing" };
    }
    if (!safeEqualSecret(password, auth.password)) {
      limiter?.recordFailure(ip, rateLimitScope);
      return { ok: false, reason: "password_mismatch" };
    }
    limiter?.reset(ip, rateLimitScope);
    return { ok: true, method: "password" };
  }

  limiter?.recordFailure(ip, rateLimitScope);
  return { ok: false, reason: "unauthorized" };
}

export async function authorizeHttpGatewayConnect(
  params: Omit<AuthorizeGatewayConnectParams, "authSurface">,
): Promise<GatewayAuthResult> {
  return authorizeGatewayConnect({
    ...params,
    authSurface: "http",
  });
}

export async function authorizeWsControlUiGatewayConnect(
  params: Omit<AuthorizeGatewayConnectParams, "authSurface">,
): Promise<GatewayAuthResult> {
  return authorizeGatewayConnect({
    ...params,
    authSurface: "ws-control-ui",
  });
}
