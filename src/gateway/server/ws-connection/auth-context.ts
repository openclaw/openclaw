import type { IncomingMessage } from "node:http";
import {
  AUTH_RATE_LIMIT_SCOPE_DEVICE_TOKEN,
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

export type DeviceTokenCandidateSource = "explicit-device-token" | "shared-token-fallback";

export type ConnectAuthState = {
  authResult: GatewayAuthResult;
  authOk: boolean;
  authMethod: GatewayAuthResult["method"];
  sharedAuthOk: boolean;
  sharedAuthProvided: boolean;
  deviceTokenCandidate?: string;
  deviceTokenCandidateSource?: DeviceTokenCandidateSource;
};

type VerifyDeviceTokenResult = { ok: boolean };

export type ConnectAuthDecision = {
  authResult: GatewayAuthResult;
  authOk: boolean;
  authMethod: GatewayAuthResult["method"];
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

function resolveDeviceTokenCandidate(connectAuth: HandshakeConnectAuth | null | undefined): {
  token?: string;
  source?: DeviceTokenCandidateSource;
} {
  const explicitDeviceToken = trimToUndefined(connectAuth?.deviceToken);
  if (explicitDeviceToken) {
    return { token: explicitDeviceToken, source: "explicit-device-token" };
  }
  const fallbackToken = trimToUndefined(connectAuth?.token);
  if (!fallbackToken) {
    return {};
  }
  return { token: fallbackToken, source: "shared-token-fallback" };
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
  const { token: deviceTokenCandidate, source: deviceTokenCandidateSource } =
    params.hasDeviceIdentity ? resolveDeviceTokenCandidate(params.connectAuth) : {};
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
  // Trusted-proxy auth is semantically shared: the proxy vouches for identity,
  // no per-device credential needed. Include it so operator connections
  // can skip device identity via roleCanSkipDeviceIdentity().
  const sharedAuthOk =
    (sharedAuthResult?.ok === true &&
      (sharedAuthResult.method === "token" || sharedAuthResult.method === "password")) ||
    (authResult.ok && authResult.method === "trusted-proxy");

  return {
    authResult,
    authOk: authResult.ok,
    authMethod:
      authResult.method ?? (params.resolvedAuth.mode === "password" ? "password" : "token"),
    sharedAuthOk,
    sharedAuthProvided,
    deviceTokenCandidate,
    deviceTokenCandidateSource,
  };
}

export async function resolveConnectAuthDecision(params: {
  state: ConnectAuthState;
  hasDeviceIdentity: boolean;
  deviceId?: string;
  role: string;
  scopes: string[];
  rateLimiter?: AuthRateLimiter;
  clientIp?: string;
  verifyDeviceToken: (params: {
    deviceId: string;
    token: string;
    role: string;
    scopes: string[];
  }) => Promise<VerifyDeviceTokenResult>;
}): Promise<ConnectAuthDecision> {
  let authResult = params.state.authResult;
  let authOk = params.state.authOk;
  let authMethod = params.state.authMethod;

  const deviceTokenCandidate = params.state.deviceTokenCandidate;
  if (!params.hasDeviceIdentity || !params.deviceId || authOk || !deviceTokenCandidate) {
    return { authResult, authOk, authMethod };
  }

  if (params.rateLimiter) {
    const deviceRateCheck = params.rateLimiter.check(
      params.clientIp,
      AUTH_RATE_LIMIT_SCOPE_DEVICE_TOKEN,
    );
    if (!deviceRateCheck.allowed) {
      authResult = {
        ok: false,
        reason: "rate_limited",
        rateLimited: true,
        retryAfterMs: deviceRateCheck.retryAfterMs,
      };
    }
  }
  if (!authResult.rateLimited) {
    const tokenCheck = await params.verifyDeviceToken({
      deviceId: params.deviceId,
      token: deviceTokenCandidate,
      role: params.role,
      scopes: params.scopes,
    });
    if (tokenCheck.ok) {
      authOk = true;
      authMethod = "device-token";
      params.rateLimiter?.reset(params.clientIp, AUTH_RATE_LIMIT_SCOPE_DEVICE_TOKEN);
    } else {
      authResult = {
        ok: false,
        reason:
          params.state.deviceTokenCandidateSource === "explicit-device-token"
            ? "device_token_mismatch"
            : (authResult.reason ?? "device_token_mismatch"),
      };
      params.rateLimiter?.recordFailure(params.clientIp, AUTH_RATE_LIMIT_SCOPE_DEVICE_TOKEN);
    }
  }

  return { authResult, authOk, authMethod };
}
