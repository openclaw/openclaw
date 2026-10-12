// WebSocket auth context resolves handshake credentials before device pairing and capability checks run.
import type { IncomingMessage } from "node:http";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { ConnectParams } from "../../../../packages/gateway-protocol/src/index.js";
import type { verifyDeviceBootstrapToken } from "../../../infra/device-bootstrap.js";
import type { verifyDeviceToken } from "../../../infra/device-pairing-tokens.js";
import {
  AUTH_RATE_LIMIT_SCOPE_BOOTSTRAP_TOKEN,
  AUTH_RATE_LIMIT_SCOPE_DEVICE_TOKEN,
  AUTH_RATE_LIMIT_SCOPE_SHARED_SECRET,
  type AuthRateLimiter,
} from "../../auth-rate-limit.js";
import {
  authorizeHttpGatewayConnect,
  authorizeWsControlUiGatewayConnect,
  type GatewayAuthResult,
  type ResolvedGatewayAuth,
} from "../../auth.js";
import { PROXY_ATTRIBUTION_REQUIRED_REASON } from "../../ingress-attribution.js";
import { withSerializedRateLimitAttempt } from "../../rate-limit-attempt-serialization.js";

type DeviceTokenCandidateSource = "explicit-device-token" | "shared-token-fallback";

type ConnectAuthState = {
  authResult: GatewayAuthResult;
  authOk: boolean;
  authMethod: GatewayAuthResult["method"];
  sharedAuthOk: boolean;
  pendingSharedAuthFailure: boolean;
  bootstrapTokenCandidate?: string;
  deviceTokenCandidate?: string;
  deviceTokenCandidateSource?: DeviceTokenCandidateSource;
};

type ConnectAuthDecision = {
  authResult: GatewayAuthResult;
  authOk: boolean;
  authMethod: GatewayAuthResult["method"];
  deviceTokenSharedGatewaySessionGeneration?: string;
};

type ResolveConnectAuthDecisionParams = {
  state: ConnectAuthState;
  hasDeviceIdentity: boolean;
  deviceId?: string;
  publicKey?: string;
  role: string;
  scopes: string[];
  requireBootstrapToken?: boolean;
  rateLimiter?: AuthRateLimiter;
  clientIp?: string;
  verifyBootstrapToken: typeof verifyDeviceBootstrapToken;
  verifyDeviceToken: typeof verifyDeviceToken;
};

export async function resolveConnectAuthState(params: {
  resolvedAuth: ResolvedGatewayAuth;
  connectAuth: ConnectParams["auth"] | null;
  hasDeviceIdentity: boolean;
  req: IncomingMessage;
  trustedProxies: string[];
  allowRealIpFallback: boolean;
  rateLimiter?: AuthRateLimiter;
  clientIp?: string;
}): Promise<ConnectAuthState> {
  const token = normalizeOptionalString(params.connectAuth?.token);
  const password = normalizeOptionalString(params.connectAuth?.password);
  const sharedConnectAuth = token || password ? { token, password } : undefined;
  const bootstrapTokenCandidate = params.hasDeviceIdentity
    ? normalizeOptionalString(params.connectAuth?.bootstrapToken)
    : undefined;
  const explicitDeviceToken = params.hasDeviceIdentity
    ? normalizeOptionalString(params.connectAuth?.deviceToken)
    : undefined;
  const deviceCredential = params.hasDeviceIdentity ? (explicitDeviceToken ?? token) : undefined;
  const deferRateLimitFailure = Boolean(deviceCredential);

  const authResult: GatewayAuthResult = await authorizeWsControlUiGatewayConnect({
    auth: params.resolvedAuth,
    connectAuth: sharedConnectAuth,
    req: params.req,
    trustedProxies: params.trustedProxies,
    allowRealIpFallback: params.allowRealIpFallback,
    rateLimiter: sharedConnectAuth ? params.rateLimiter : undefined,
    clientIp: params.clientIp,
    rateLimitScope: AUTH_RATE_LIMIT_SCOPE_SHARED_SECRET,
    deferRateLimitFailure,
  });

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
  const pendingSharedAuthFailure =
    deferRateLimitFailure &&
    (authResult.reason === "token_mismatch" || authResult.reason === "password_mismatch");

  return {
    authResult,
    authOk: authResult.ok,
    authMethod:
      authResult.method ?? (params.resolvedAuth.mode === "password" ? "password" : "token"),
    sharedAuthOk,
    pendingSharedAuthFailure,
    bootstrapTokenCandidate,
    deviceTokenCandidate: deviceCredential,
    deviceTokenCandidateSource: explicitDeviceToken
      ? "explicit-device-token"
      : deviceCredential
        ? "shared-token-fallback"
        : undefined,
  };
}

export async function resolveConnectAuthDecision(
  params: ResolveConnectAuthDecisionParams,
): Promise<ConnectAuthDecision> {
  const shouldSerializeBootstrapAttempt = Boolean(
    params.rateLimiter &&
    params.hasDeviceIdentity &&
    params.deviceId &&
    params.publicKey &&
    params.state.bootstrapTokenCandidate,
  );
  if (!shouldSerializeBootstrapAttempt) {
    return await resolveConnectAuthDecisionCore(params);
  }
  return await withSerializedRateLimitAttempt({
    ip: params.clientIp,
    scope: AUTH_RATE_LIMIT_SCOPE_BOOTSTRAP_TOKEN,
    run: async () => await resolveConnectAuthDecisionCore(params),
  });
}

async function resolveConnectAuthDecisionCore(
  params: ResolveConnectAuthDecisionParams,
): Promise<ConnectAuthDecision> {
  let authResult = params.state.authResult;
  let authOk = params.state.authOk;
  let authMethod = params.state.authMethod;
  let deviceTokenSharedGatewaySessionGeneration: string | undefined;
  let pendingBootstrapFailure = false;

  async function finish(): Promise<ConnectAuthDecision> {
    if (params.state.pendingSharedAuthFailure && !authOk) {
      await params.rateLimiter?.recordFailureAndDelay(
        params.clientIp,
        AUTH_RATE_LIMIT_SCOPE_SHARED_SECRET,
      );
    }
    if (pendingBootstrapFailure && !authOk) {
      params.rateLimiter?.recordFailure(params.clientIp, AUTH_RATE_LIMIT_SCOPE_BOOTSTRAP_TOKEN);
    }
    return {
      authResult,
      authOk,
      authMethod,
      deviceTokenSharedGatewaySessionGeneration,
    };
  }

  // Invalid ingress or a redacted configured credential cannot be repaired by
  // trying another device/bootstrap credential during this handshake.
  if (
    authResult.reason === PROXY_ATTRIBUTION_REQUIRED_REASON ||
    authResult.reason === "token_redacted_config" ||
    authResult.reason === "password_redacted_config"
  ) {
    return await finish();
  }

  const bootstrapTokenCandidate = params.state.bootstrapTokenCandidate;
  if (params.hasDeviceIdentity && params.deviceId && params.publicKey && bootstrapTokenCandidate) {
    // Bootstrap verification shares the SQLite worker mutation queue.
    // Limit attempts before they can delay legitimate onboarding.
    let bootstrapRateLimited = false;
    if (params.rateLimiter) {
      const bootstrapRateCheck = params.rateLimiter.check(
        params.clientIp,
        AUTH_RATE_LIMIT_SCOPE_BOOTSTRAP_TOKEN,
      );
      if (!bootstrapRateCheck.allowed) {
        bootstrapRateLimited = true;
        if (!authOk || params.requireBootstrapToken) {
          authOk = false;
          authResult = {
            ok: false,
            reason: "rate_limited",
            rateLimited: true,
            retryAfterMs: bootstrapRateCheck.retryAfterMs,
          };
        }
      }
    }
    if (!bootstrapRateLimited) {
      const tokenCheck = await params.verifyBootstrapToken({
        deviceId: params.deviceId,
        publicKey: params.publicKey,
        token: bootstrapTokenCandidate,
        role: params.role,
        scopes: params.scopes,
      });
      if (tokenCheck.ok) {
        // Prefer an explicit valid bootstrap token even when another auth path
        // (for example tailscale serve header auth) already succeeded. QR pairing
        // relies on the server classifying the handshake as bootstrap-token so the
        // initial node pairing can be silently auto-approved and the bootstrap
        // token can be revoked after approval.
        authOk = true;
        authMethod = "bootstrap-token";
        params.rateLimiter?.reset(params.clientIp, AUTH_RATE_LIMIT_SCOPE_BOOTSTRAP_TOKEN);
      } else {
        pendingBootstrapFailure = true;
        if (!authOk || params.requireBootstrapToken) {
          authOk = false;
          authResult = { ok: false, reason: tokenCheck.reason ?? "bootstrap_token_invalid" };
        }
      }
    }
  }

  const deviceTokenCandidate = params.state.deviceTokenCandidate;
  if (!params.hasDeviceIdentity || !params.deviceId || authOk || !deviceTokenCandidate) {
    return await finish();
  }

  const deviceRateCheck = params.rateLimiter?.check(
    params.clientIp,
    AUTH_RATE_LIMIT_SCOPE_DEVICE_TOKEN,
  );
  if (deviceRateCheck && !deviceRateCheck.allowed) {
    authResult = {
      ok: false,
      reason: "rate_limited",
      rateLimited: true,
      retryAfterMs: deviceRateCheck.retryAfterMs,
    };
    return await finish();
  }
  const tokenCheck = await params.verifyDeviceToken({
    deviceId: params.deviceId,
    token: deviceTokenCandidate,
    role: params.role,
    scopes: params.scopes,
  });
  if (tokenCheck.ok) {
    authOk = true;
    authMethod = "device-token";
    if (tokenCheck.issuer?.kind === "shared-gateway-auth") {
      deviceTokenSharedGatewaySessionGeneration = tokenCheck.issuer.generation;
    }
    params.rateLimiter?.reset(params.clientIp, AUTH_RATE_LIMIT_SCOPE_DEVICE_TOKEN);
  } else {
    authResult = {
      ok: false,
      reason:
        tokenCheck.reason === "scope-mismatch" || tokenCheck.reason === "scope_mismatch"
          ? "scope_mismatch"
          : params.state.deviceTokenCandidateSource === "explicit-device-token"
            ? "device_token_mismatch"
            : (authResult.reason ?? "device_token_mismatch"),
    };
    params.rateLimiter?.recordFailure(params.clientIp, AUTH_RATE_LIMIT_SCOPE_DEVICE_TOKEN);
  }

  return await finish();
}
