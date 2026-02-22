import type { IncomingMessage } from "node:http";
import {
  AUTH_RATE_LIMIT_SCOPE_SHARED_SECRET,
  type AuthRateLimiter,
  type RateLimitCheckResult,
} from "../../auth-rate-limit.js";
import {
  authorizeHttpGatewayConnect,
  authorizeWsControlUiGatewayConnect,
  type GatewayAuthResult,
  type ResolvedGatewayAuth,
} from "../../auth.js";

type HandshakeConnectAuth = {
  token?: string;
  deviceToken?: string;
  password?: string;
};

export type ConnectAuthState = {
  authResult: GatewayAuthResult;
  authOk: boolean;
  authMethod: GatewayAuthResult["method"];
  sharedAuthOk: boolean;
  sharedAuthProvided: boolean;
  deviceTokenCandidate?: string;
};

function trimToUndefined(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function resolveSharedConnectAuth(
  connectAuth: HandshakeConnectAuth | null | undefined,
): { token?: string; password?: string } | undefined {
  const token = trimToUndefined(connectAuth?.token);
  const password = trimToUndefined(connectAuth?.password);
  if (!token && !password) {
    return undefined;
  }
  return { token, password };
}

function resolveDeviceTokenCandidate(
  connectAuth: HandshakeConnectAuth | null | undefined,
): string | undefined {
  const explicitDeviceToken = trimToUndefined(connectAuth?.deviceToken);
  if (explicitDeviceToken) {
    return explicitDeviceToken;
  }
  return trimToUndefined(connectAuth?.token);
}

export async function resolveConnectAuthState(params: {
  resolvedAuth: ResolvedGatewayAuth;
  connectAuth: HandshakeConnectAuth | null | undefined;
  hasDeviceIdentity: boolean;
  req: IncomingMessage;
  trustedProxies: string[];
  allowRealIpFallback: boolean;
  rateLimiter?: AuthRateLimiter;
  clientIp?: string;
}): Promise<ConnectAuthState> {
  const sharedConnectAuth = resolveSharedConnectAuth(params.connectAuth);
  const sharedAuthProvided = Boolean(sharedConnectAuth);
  const deviceTokenCandidate = params.hasDeviceIdentity
    ? resolveDeviceTokenCandidate(params.connectAuth)
    : undefined;
  const hasDeviceTokenCandidate = Boolean(deviceTokenCandidate);

  let authResult: GatewayAuthResult = await authorizeWsControlUiGatewayConnect({
    auth: params.resolvedAuth,
    connectAuth: sharedConnectAuth,
    req: params.req,
    trustedProxies: params.trustedProxies,
    allowRealIpFallback: params.allowRealIpFallback,
    rateLimiter: hasDeviceTokenCandidate ? undefined : params.rateLimiter,
    clientIp: params.clientIp,
    rateLimitScope: AUTH_RATE_LIMIT_SCOPE_SHARED_SECRET,
  });

  if (
    hasDeviceTokenCandidate &&
    authResult.ok &&
    params.rateLimiter &&
    (authResult.method === "token" || authResult.method === "password")
  ) {
    const sharedRateCheck: RateLimitCheckResult = params.rateLimiter.check(
      params.clientIp,
      AUTH_RATE_LIMIT_SCOPE_SHARED_SECRET,
    );
    if (!sharedRateCheck.allowed) {
      authResult = {
        ok: false,
        reason: "rate_limited",
        rateLimited: true,
        retryAfterMs: sharedRateCheck.retryAfterMs,
      };
    } else {
      params.rateLimiter.reset(params.clientIp, AUTH_RATE_LIMIT_SCOPE_SHARED_SECRET);
    }
  }

  const sharedAuthResult =
    sharedConnectAuth &&
    (await authorizeHttpGatewayConnect({
      auth: { ...params.resolvedAuth, allowTailscale: false },
      connectAuth: sharedConnectAuth,
      req: params.req,
      trustedProxies: params.trustedProxies,
      allowRealIpFallback: params.allowRealIpFallback,
      // Shared-auth probe only; rate-limit side effects are handled in the
      // primary auth flow (or deferred for device-token candidates).
      rateLimitScope: AUTH_RATE_LIMIT_SCOPE_SHARED_SECRET,
    }));
  const sharedAuthOk =
    sharedAuthResult?.ok === true &&
    (sharedAuthResult.method === "token" || sharedAuthResult.method === "password");

  return {
    authResult,
    authOk: authResult.ok,
    authMethod:
      authResult.method ?? (params.resolvedAuth.mode === "password" ? "password" : "token"),
    sharedAuthOk,
    sharedAuthProvided,
    deviceTokenCandidate,
  };
}
