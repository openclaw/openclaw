const DEFAULT_MAX_AUTHENTICATED_CONNECTIONS_PER_IDENTITY = 8;

export function getMaxAuthenticatedConnectionsPerIdentityFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const configured =
    env.OPENCLAW_MAX_AUTHENTICATED_CONNECTIONS_PER_IDENTITY ||
    (env.VITEST && env.OPENCLAW_TEST_MAX_AUTHENTICATED_CONNECTIONS_PER_IDENTITY);
  if (!configured) {
    return DEFAULT_MAX_AUTHENTICATED_CONNECTIONS_PER_IDENTITY;
  }
  const parsed = Number(configured);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return DEFAULT_MAX_AUTHENTICATED_CONNECTIONS_PER_IDENTITY;
  }
  return Math.floor(parsed);
}

export type AuthenticatedConnectionBudget = {
  acquire(deviceId: string): boolean;
  release(deviceId: string | null): void;
};

export function createAuthenticatedConnectionBudget(
  limit = getMaxAuthenticatedConnectionsPerIdentityFromEnv(),
): AuthenticatedConnectionBudget {
  const counts = new Map<string, number>();

  return {
    acquire(deviceId) {
      const next = (counts.get(deviceId) ?? 0) + 1;
      if (next > limit) {
        return false;
      }
      counts.set(deviceId, next);
      return true;
    },
    release(deviceId) {
      if (!deviceId) {
        return;
      }
      const current = counts.get(deviceId);
      if (current === undefined) {
        return;
      }
      if (current <= 1) {
        counts.delete(deviceId);
        return;
      }
      counts.set(deviceId, current - 1);
    },
  };
}
