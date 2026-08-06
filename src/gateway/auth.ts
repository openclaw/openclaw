// Gateway connection authorization.
// Authorizes HTTP/websocket gateway requests across shared-secret, Tailscale, and proxy modes.
import type { IncomingMessage } from "node:http";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import type { GatewayAuthConfig, GatewayTrustedProxyConfig } from "../config/types.gateway.js";
import { safeEqualSecret } from "../security/secret-equal.js";
import {
  AUTH_RATE_LIMIT_SCOPE_SHARED_SECRET,
  type AuthRateLimitSubject,
  type AuthRateLimiter,
  type RateLimitCheckResult,
} from "./auth-rate-limit.js";
import type { ResolvedGatewayAuth } from "./auth-resolve.js";
import {
  PROXY_ATTRIBUTION_REQUIRED_REASON,
  type GatewayIngressAttribution,
  type VerifiedTailscaleIngressIdentity,
} from "./ingress-attribution.js";
import {
  isLocalDirectRequest,
  isLoopbackAddress,
  resolveLocalInterfaceAddressMatch,
  resolveRequestClientIp,
  isTrustedProxyAddress,
} from "./net.js";
import { checkBrowserOrigin } from "./origin-check.js";
import { withSerializedRateLimitAttempt } from "./rate-limit-attempt-serialization.js";
export {
  resolveEffectiveSharedGatewayAuth,
  resolveGatewayAuth,
  type ResolvedGatewayAuth,
} from "./auth-resolve.js";
export { hasForwardedRequestHeaders, isLocalDirectRequest } from "./net.js";

const LEGACY_OPENCLAW_ENV_NOTE =
  " Legacy CLAWDBOT_* and MOLTBOT_* environment variables are ignored; use OPENCLAW_* names.";

/** Normalized outcome for gateway shared-secret, Tailscale, device, and proxy auth. */
export type GatewayAuthResult = {
  ok: boolean;
  method?:
    | "none"
    | "token"
    | "password"
    | "tailscale"
    | "device-token"
    | "bootstrap-token"
    | "trusted-proxy";
  user?: string;
  /** Full verified Tailscale identity; present only after header + WhoIs agreement. */
  tailscaleIdentity?: VerifiedTailscaleIdentity;
  reason?: string;
  /** Present when the request was blocked by the rate limiter. */
  rateLimited?: boolean;
  /** Milliseconds the client should wait before retrying (when rate-limited). */
  retryAfterMs?: number;
};

type ConnectAuth = {
  token?: string;
  password?: string;
};

type GatewayAuthSurface = "http" | "http-user-profile-avatar" | "ws-control-ui";

/** Inputs needed to authorize one HTTP or websocket gateway connection. */
type AuthorizeGatewayConnectParams = {
  auth: ResolvedGatewayAuth;
  connectAuth?: ConnectAuth | null;
  req?: IncomingMessage;
  trustedProxies?: string[];
  ingressAttribution?: GatewayIngressAttribution;
  /**
   * Explicit auth surface. HTTP keeps Tailscale forwarded-header auth disabled.
   * WS Control UI enables it intentionally for tokenless trusted-host login.
   */
  authSurface?: GatewayAuthSurface;
  /** Optional rate limiter instance; when provided, failed attempts are tracked per IP. */
  rateLimiter?: AuthRateLimiter;
  /** Client IP used for rate-limit tracking. Falls back to proxy-aware request IP resolution. */
  clientIp?: string | AuthRateLimitSubject;
  /** Optional limiter scope; defaults to shared-secret auth scope. */
  rateLimitScope?: string;
  /** Trust X-Real-IP only when explicitly enabled. */
  allowRealIpFallback?: boolean;
  /** Optional browser-origin policy for HTTP requests that require Origin checks. */
  browserOriginPolicy?: {
    requestHost?: string;
    origin?: string;
    fetchSite?: string;
    allowedOrigins?: string[];
    allowHostHeaderOriginFallback?: boolean;
  };
};

type VerifiedTailscaleIdentity = VerifiedTailscaleIngressIdentity;

type GatewayAuthRequestContext = {
  authSurface: GatewayAuthSurface;
  limiter?: AuthRateLimiter;
  subject?: string | AuthRateLimitSubject;
  rateLimitScope: string;
  localDirect: boolean;
  resetOnSuccess: boolean;
  ingressAttribution?: GatewayIngressAttribution;
};

function resolveGatewayAuthRequestContext(
  params: AuthorizeGatewayConnectParams,
): GatewayAuthRequestContext {
  const { req, trustedProxies } = params;
  const authSurface = params.authSurface ?? "http";
  const attributed =
    params.ingressAttribution?.kind === "unattributable-proxy"
      ? undefined
      : params.ingressAttribution;
  const fallbackIp =
    attributed?.clientIp ??
    resolveRequestClientIp(req, trustedProxies, params.allowRealIpFallback === true) ??
    req?.socket?.remoteAddress;

  return {
    authSurface,
    limiter: params.rateLimiter,
    // Browser-origin and other owner-selected limiter keys stay authoritative;
    // prepared ingress supplies locality/reset policy and the default subject.
    subject: params.clientIp ?? attributed?.rateLimit.subject ?? fallbackIp,
    rateLimitScope: params.rateLimitScope ?? AUTH_RATE_LIMIT_SCOPE_SHARED_SECRET,
    localDirect:
      attributed?.localDirect ??
      isLocalDirectRequest(req, trustedProxies, params.allowRealIpFallback === true),
    resetOnSuccess: attributed?.rateLimit.resetOnSuccess ?? true,
    ingressAttribution: params.ingressAttribution,
  };
}

function hasExplicitSharedSecretAuth(connectAuth?: ConnectAuth | null): boolean {
  return Boolean(
    normalizeOptionalString(connectAuth?.token) || normalizeOptionalString(connectAuth?.password),
  );
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** Validate that the selected gateway auth mode has the required resolved credentials/config. */
export function assertGatewayAuthConfigured(
  auth: ResolvedGatewayAuth,
  rawAuthConfig?: GatewayAuthConfig | null,
): void {
  if (auth.mode === "token" && !auth.token) {
    if (auth.allowTailscale) {
      return;
    }
    throw new Error(
      `gateway auth mode is token, but no token was configured (set gateway.auth.token or OPENCLAW_GATEWAY_TOKEN).${LEGACY_OPENCLAW_ENV_NOTE}`,
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
    throw new Error(
      `gateway auth mode is password, but no password was configured.${LEGACY_OPENCLAW_ENV_NOTE}`,
    );
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
    if (auth.token) {
      throw new Error(
        "gateway auth mode is trusted-proxy, but a shared token is also configured; remove gateway.auth.token / OPENCLAW_GATEWAY_TOKEN because trusted-proxy and token auth are mutually exclusive",
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
  const remoteIsLoopback = isLoopbackAddress(remoteAddr);
  if (remoteIsLoopback && trustedProxyConfig.allowLoopback !== true) {
    return { reason: "trusted_proxy_loopback_source" };
  }
  if (!remoteIsLoopback) {
    const localInterfaceMatch = resolveLocalInterfaceAddressMatch(remoteAddr);
    if (localInterfaceMatch === undefined) {
      return { reason: "trusted_proxy_local_interface_check_failed" };
    }
    if (localInterfaceMatch) {
      return { reason: "trusted_proxy_local_interface_source" };
    }
  }

  const requiredHeaders = trustedProxyConfig.requiredHeaders ?? [];
  for (const header of requiredHeaders) {
    const value = headerValue(req.headers[normalizeLowercaseStringOrEmpty(header)]);
    if (!value || value.trim() === "") {
      return { reason: `trusted_proxy_missing_header_${header}` };
    }
  }

  const userHeaderValue = headerValue(
    req.headers[normalizeLowercaseStringOrEmpty(trustedProxyConfig.userHeader)],
  );
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
  return authSurface === "ws-control-ui" || authSurface === "http-user-profile-avatar";
}

function authorizeHttpBrowserOrigin(params: {
  authSurface: GatewayAuthSurface;
  browserOriginPolicy?: AuthorizeGatewayConnectParams["browserOriginPolicy"];
  isLocalClient: boolean;
  reason: string;
  requireSameOriginFetchWithoutOrigin?: boolean;
  allowWildcardOrigin?: boolean;
}): { ok: false; reason: string } | null {
  if (params.authSurface === "ws-control-ui") {
    return null;
  }

  const origin = params.browserOriginPolicy?.origin?.trim();
  if (!origin) {
    return params.requireSameOriginFetchWithoutOrigin &&
      normalizeLowercaseStringOrEmpty(params.browserOriginPolicy?.fetchSite) !== "same-origin"
      ? { ok: false, reason: params.reason }
      : null;
  }

  const originCheck = checkBrowserOrigin({
    requestHost: params.browserOriginPolicy?.requestHost,
    origin,
    allowedOrigins:
      params.allowWildcardOrigin === false
        ? params.browserOriginPolicy?.allowedOrigins?.filter(
            (candidate) => normalizeLowercaseStringOrEmpty(candidate) !== "*",
          )
        : params.browserOriginPolicy?.allowedOrigins,
    allowHostHeaderOriginFallback: params.browserOriginPolicy?.allowHostHeaderOriginFallback,
    isLocalClient: params.isLocalClient,
  });
  if (originCheck.ok) {
    return null;
  }
  return { ok: false, reason: params.reason };
}

function authorizeTrustedProxyBrowserOrigin(params: {
  authSurface: GatewayAuthSurface;
  browserOriginPolicy?: AuthorizeGatewayConnectParams["browserOriginPolicy"];
}): { ok: false; reason: string } | null {
  return authorizeHttpBrowserOrigin({
    ...params,
    isLocalClient: false,
    reason: "trusted_proxy_origin_not_allowed",
  });
}

async function authorizeTokenAuth(params: {
  authToken?: string;
  connectToken?: string;
  limiter?: AuthRateLimiter;
  subject?: string | AuthRateLimitSubject;
  rateLimitScope: string;
  resetOnSuccess: boolean;
}): Promise<GatewayAuthResult> {
  if (!params.authToken) {
    return { ok: false, reason: "token_missing_config" };
  }
  if (!params.connectToken) {
    // Don't burn rate-limit slots for missing credentials — the client
    // simply hasn't provided a token yet (e.g. bare browser open).
    // Only actual *wrong* credentials should count as failures.
    return { ok: false, reason: "token_missing" };
  }
  if (!safeEqualSecret(params.connectToken, params.authToken)) {
    await params.limiter?.recordFailureAndDelay(params.subject, params.rateLimitScope);
    return { ok: false, reason: "token_mismatch" };
  }
  if (params.resetOnSuccess) {
    params.limiter?.reset(params.subject, params.rateLimitScope);
  }
  return { ok: true, method: "token" };
}

async function authorizePasswordAuth(params: {
  authPassword?: string;
  connectPassword?: string;
  limiter?: AuthRateLimiter;
  subject?: string | AuthRateLimitSubject;
  rateLimitScope: string;
  resetOnSuccess: boolean;
}): Promise<GatewayAuthResult> {
  if (!params.authPassword) {
    return { ok: false, reason: "password_missing_config" };
  }
  if (!params.connectPassword) {
    // Same as token_missing — don't penalize absent credentials.
    return { ok: false, reason: "password_missing" };
  }
  if (!safeEqualSecret(params.connectPassword, params.authPassword)) {
    await params.limiter?.recordFailureAndDelay(params.subject, params.rateLimitScope);
    return { ok: false, reason: "password_mismatch" };
  }
  if (params.resetOnSuccess) {
    params.limiter?.reset(params.subject, params.rateLimitScope);
  }
  return { ok: true, method: "password" };
}

function rejectIfRateLimited(params: {
  limiter?: AuthRateLimiter;
  subject?: string | AuthRateLimitSubject;
  rateLimitScope: string;
}): GatewayAuthResult | undefined {
  if (!params.limiter) {
    return undefined;
  }
  const rlCheck: RateLimitCheckResult = params.limiter.check(params.subject, params.rateLimitScope);
  if (rlCheck.allowed) {
    return undefined;
  }
  return {
    ok: false,
    reason: "rate_limited",
    rateLimited: true,
    retryAfterMs: rlCheck.retryAfterMs,
  };
}

/** Authorize a gateway connection, including rate-limit handling around shared-secret failures. */
async function authorizeGatewayConnect(
  params: AuthorizeGatewayConnectParams,
): Promise<GatewayAuthResult> {
  const { auth } = params;
  const ingressAttribution = params.ingressAttribution;
  if (ingressAttribution?.kind === "unattributable-proxy") {
    return { ok: false, reason: PROXY_ATTRIBUTION_REQUIRED_REASON };
  }
  const preparedParams = ingressAttribution ? { ...params, ingressAttribution } : params;
  const { authSurface, limiter, subject, rateLimitScope, localDirect } =
    resolveGatewayAuthRequestContext(preparedParams);

  // Keep the limiter strict on the async Tailscale branch by serializing
  // attempts for the same {scope, ip} key across the pre-check and failure write.
  if (
    limiter &&
    shouldAllowTailscaleHeaderAuth(authSurface) &&
    auth.allowTailscale &&
    !localDirect
  ) {
    return await withSerializedRateLimitAttempt({
      ip: subject,
      scope: rateLimitScope,
      run: async () => await authorizeGatewayConnectCore(preparedParams),
    });
  }

  return await authorizeGatewayConnectCore(preparedParams);
}

async function authorizeGatewayConnectCore(
  params: AuthorizeGatewayConnectParams,
): Promise<GatewayAuthResult> {
  const { auth, connectAuth, req, trustedProxies } = params;
  const {
    authSurface,
    limiter,
    subject,
    rateLimitScope,
    localDirect,
    resetOnSuccess,
    ingressAttribution,
  } = resolveGatewayAuthRequestContext(params);
  const allowTailscaleHeaderAuth = shouldAllowTailscaleHeaderAuth(authSurface);

  if (auth.mode === "trusted-proxy") {
    // Same-host reverse proxies may forward identity headers without a full
    // forwarded chain; keep those on the trusted-proxy path so allowUsers and
    // requiredHeaders still apply.
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
      const originResult = authorizeTrustedProxyBrowserOrigin({
        authSurface,
        browserOriginPolicy: params.browserOriginPolicy,
      });
      if (originResult) {
        return originResult;
      }
      return { ok: true, method: "trusted-proxy", user: result.user };
    }
    if (localDirect && auth.password && connectAuth?.password) {
      const rateLimitResult = rejectIfRateLimited({ limiter, subject, rateLimitScope });
      if (rateLimitResult) {
        return rateLimitResult;
      }
      return await authorizePasswordAuth({
        authPassword: auth.password,
        connectPassword: connectAuth.password,
        limiter,
        subject,
        rateLimitScope,
        resetOnSuccess,
      });
    }
    return { ok: false, reason: result.reason };
  }

  if (auth.mode === "none") {
    const originResult = authorizeHttpBrowserOrigin({
      authSurface,
      browserOriginPolicy: params.browserOriginPolicy,
      isLocalClient: localDirect,
      reason: "origin_not_allowed",
    });
    if (originResult) {
      return originResult;
    }
    return { ok: true, method: "none" };
  }

  if (
    allowTailscaleHeaderAuth &&
    auth.allowTailscale &&
    !localDirect &&
    !hasExplicitSharedSecretAuth(connectAuth) &&
    ingressAttribution?.kind === "tailscale-serve"
  ) {
    if (authSurface === "http-user-profile-avatar") {
      // Same-origin <img> loads may omit Origin, but Fetch Metadata still identifies
      // their source. Ambient identity accepts that omission only for same-origin loads,
      // and wildcard CORS never grants ambient identity.
      const originResult = authorizeHttpBrowserOrigin({
        authSurface,
        browserOriginPolicy: params.browserOriginPolicy,
        isLocalClient: localDirect,
        reason: "origin_not_allowed",
        requireSameOriginFetchWithoutOrigin: true,
        allowWildcardOrigin: false,
      });
      if (originResult) {
        return originResult;
      }
    }
    const tailscaleIdentity = await ingressAttribution.verifyIdentity();
    if (tailscaleIdentity) {
      if (resetOnSuccess) {
        limiter?.reset(subject, rateLimitScope);
      }
      return {
        ok: true,
        method: "tailscale",
        user: tailscaleIdentity.login,
        tailscaleIdentity,
      };
    }
  }

  const rateLimitResult = rejectIfRateLimited({ limiter, subject, rateLimitScope });
  if (rateLimitResult) {
    return rateLimitResult;
  }

  if (auth.mode === "token") {
    return await authorizeTokenAuth({
      authToken: auth.token,
      connectToken: connectAuth?.token,
      limiter,
      subject,
      rateLimitScope,
      resetOnSuccess,
    });
  }

  if (auth.mode === "password") {
    return await authorizePasswordAuth({
      authPassword: auth.password,
      connectPassword: connectAuth?.password,
      limiter,
      subject,
      rateLimitScope,
      resetOnSuccess,
    });
  }

  await limiter?.recordFailureAndDelay(subject, rateLimitScope);
  return { ok: false, reason: "unauthorized" };
}

/** Authorize an HTTP gateway request with Tailscale forwarded-header auth disabled. */
export async function authorizeHttpGatewayConnect(
  params: Omit<AuthorizeGatewayConnectParams, "authSurface">,
): Promise<GatewayAuthResult> {
  return authorizeGatewayConnect({
    ...params,
    authSurface: "http",
  });
}

/** Authorize the read-only profile avatar route, including verified Tailscale identity. */
export async function authorizeUserProfileAvatarHttpGatewayConnect(
  params: Omit<AuthorizeGatewayConnectParams, "authSurface">,
): Promise<GatewayAuthResult> {
  return authorizeGatewayConnect({
    ...params,
    authSurface: "http-user-profile-avatar",
  });
}

/** Authorize a Control UI websocket request with the WS-specific auth surface. */
export async function authorizeWsControlUiGatewayConnect(
  params: Omit<AuthorizeGatewayConnectParams, "authSurface">,
): Promise<GatewayAuthResult> {
  return authorizeGatewayConnect({
    ...params,
    authSurface: "ws-control-ui",
  });
}
