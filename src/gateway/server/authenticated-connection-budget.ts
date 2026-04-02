import type { GatewayWsClient } from "./ws-types.js";

const DEFAULT_MAX_AUTHENTICATED_CONNECTIONS_PER_IDENTITY = 8;
const UNKNOWN_AUTHENTICATED_IDENTITY_BUDGET_KEY = "__openclaw_authenticated_identity__";

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
  return Math.max(1, Math.floor(parsed));
}

function resolveAuthenticatedConnectionBudgetKey(client: GatewayWsClient): string {
  const deviceId = client.connect.device?.id?.trim();
  if (deviceId) {
    return `device:${deviceId}`;
  }
  const clientIp = client.clientIp?.trim();
  if (clientIp) {
    return `client-ip:${clientIp}`;
  }
  return `${UNKNOWN_AUTHENTICATED_IDENTITY_BUDGET_KEY}:${client.connect.role}`;
}

export type AuthenticatedConnectionBudget = {
  acquire(client: GatewayWsClient): string | null;
  release(key: string | null | undefined): void;
};

export function createAuthenticatedConnectionBudget(
  limit = getMaxAuthenticatedConnectionsPerIdentityFromEnv(),
): AuthenticatedConnectionBudget {
  const counts = new Map<string, number>();

  return {
    acquire(client) {
      const key = resolveAuthenticatedConnectionBudgetKey(client);
      const next = (counts.get(key) ?? 0) + 1;
      if (next > limit) {
        return null;
      }
      counts.set(key, next);
      return key;
    },
    release(key) {
      if (!key) {
        return;
      }
      const current = counts.get(key);
      if (current === undefined) {
        return;
      }
      if (current <= 1) {
        counts.delete(key);
        return;
      }
      counts.set(key, current - 1);
    },
  };
}
