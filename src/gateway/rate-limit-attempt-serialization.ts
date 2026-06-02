import { AUTH_RATE_LIMIT_SCOPE_DEFAULT, normalizeRateLimitClientIp } from "./auth-rate-limit.js";

const pendingAttempts = new Map<string, Promise<void>>();

function normalizeScope(scope: string | undefined): string {
  return (scope ?? AUTH_RATE_LIMIT_SCOPE_DEFAULT).trim() || AUTH_RATE_LIMIT_SCOPE_DEFAULT;
}

function buildSerializationKey(ip: string | undefined, scope: string | undefined): string {
  return `${normalizeScope(scope)}:${normalizeRateLimitClientIp(ip)}`;
}

/** Serialize rate-limit-sensitive auth attempts for one normalized IP/scope bucket. */
export async function withSerializedRateLimitAttempt<T>(params: {
  ip: string | undefined;
  scope: string | undefined;
  run: () => Promise<T>;
}): Promise<T> {
  const key = buildSerializationKey(params.ip, params.scope);
  const previous = pendingAttempts.get(key) ?? Promise.resolve();
  let releaseCurrent!: () => void;
  const current = new Promise<void>((resolve) => {
    releaseCurrent = resolve;
  });
  // Chain behind the previous tail but keep the current promise as the new
  // tail so later attempts wait for this run even when earlier attempts fail.
  const tail = previous.catch(() => {}).then(() => current);
  pendingAttempts.set(key, tail);

  await previous.catch(() => {});
  try {
    return await params.run();
  } finally {
    releaseCurrent();
    // Only the active tail may clean up the key; newer queued attempts replace
    // it before this run finishes.
    if (pendingAttempts.get(key) === tail) {
      pendingAttempts.delete(key);
    }
  }
}
