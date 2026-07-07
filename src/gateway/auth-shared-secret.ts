import { safeEqualSecret } from "../security/secret-equal.js";
import type { AuthRateLimiter } from "./auth-rate-limit.js";
import type { ResolvedGatewayAuth } from "./auth-resolve.js";

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
  reason?: string;
  /** Present when the request was blocked by the rate limiter. */
  rateLimited?: boolean;
  /** Milliseconds the client should wait before retrying (when rate-limited). */
  retryAfterMs?: number;
};

export type ConnectAuth = {
  token?: string;
  password?: string;
};

function authorizeTokenAuth(params: {
  authToken?: string;
  connectToken?: string;
  limiter?: AuthRateLimiter;
  ip?: string;
  rateLimitScope: string;
}): GatewayAuthResult {
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
    params.limiter?.recordFailure(params.ip, params.rateLimitScope);
    return { ok: false, reason: "token_mismatch" };
  }
  params.limiter?.reset(params.ip, params.rateLimitScope);
  return { ok: true, method: "token" };
}

export function authorizePasswordAuth(params: {
  authPassword?: string;
  connectPassword?: string;
  limiter?: AuthRateLimiter;
  ip?: string;
  rateLimitScope: string;
}): GatewayAuthResult {
  if (!params.authPassword) {
    return { ok: false, reason: "password_missing_config" };
  }
  if (!params.connectPassword) {
    // Same as token_missing — don't penalize absent credentials.
    return { ok: false, reason: "password_missing" };
  }
  if (!safeEqualSecret(params.connectPassword, params.authPassword)) {
    params.limiter?.recordFailure(params.ip, params.rateLimitScope);
    return { ok: false, reason: "password_mismatch" };
  }
  params.limiter?.reset(params.ip, params.rateLimitScope);
  return { ok: true, method: "password" };
}

export function authorizeSharedSecretAuth(params: {
  auth: ResolvedGatewayAuth;
  connectAuth?: ConnectAuth | null;
  limiter?: AuthRateLimiter;
  ip?: string;
  rateLimitScope: string;
}): GatewayAuthResult {
  const { auth, connectAuth, limiter, ip, rateLimitScope } = params;
  if (auth.mode === "token") {
    return authorizeTokenAuth({
      authToken: auth.token,
      connectToken: connectAuth?.token,
      limiter,
      ip,
      rateLimitScope,
    });
  }
  if (auth.mode === "password") {
    return authorizePasswordAuth({
      authPassword: auth.password,
      connectPassword: connectAuth?.password,
      limiter,
      ip,
      rateLimitScope,
    });
  }
  limiter?.recordFailure(ip, rateLimitScope);
  return { ok: false, reason: "tailscale_shared_secret_auth_unavailable" };
}
