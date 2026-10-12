import { KeyedAsyncQueue } from "../plugin-sdk/keyed-async-queue.js";
import {
  AUTH_RATE_LIMIT_SCOPE_DEFAULT,
  isAuthRateLimitClientExempt,
  normalizeRateLimitClientIp,
  type AuthRateLimiter,
} from "./auth-rate-limit.js";

const pendingAttempts = new KeyedAsyncQueue();

/** Shared queue scope for auth attempts that evaluate shared and device credentials together. */
const AUTH_CREDENTIAL_FALLBACK_SERIALIZATION_SCOPE = "credential-fallback";

export async function withSerializedRateLimitAttempt<T>(params: {
  ip: string | undefined;
  scope: string | undefined;
  run: () => Promise<T>;
}): Promise<T> {
  const scope =
    (params.scope ?? AUTH_RATE_LIMIT_SCOPE_DEFAULT).trim() || AUTH_RATE_LIMIT_SCOPE_DEFAULT;
  return await pendingAttempts.enqueue(
    `${scope}:${normalizeRateLimitClientIp(params.ip)}`,
    params.run,
  );
}

/** Serialize terminal credential fallbacks unless this limiter exempts the identity. */
export async function withSerializedCredentialFallbackAttempt<T>(params: {
  limiter: AuthRateLimiter;
  ip: string | undefined;
  run: () => Promise<T>;
}): Promise<T> {
  if (isAuthRateLimitClientExempt(params.limiter, params.ip)) {
    return await params.run();
  }
  return await withSerializedRateLimitAttempt({
    ip: params.ip,
    scope: AUTH_CREDENTIAL_FALLBACK_SERIALIZATION_SCOPE,
    run: params.run,
  });
}
