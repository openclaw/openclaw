import { resolveClientIp } from "../net.js";

const DEFAULT_MAX_PREAUTH_CONNECTIONS_PER_IP = 32;

export function getMaxPreauthConnectionsPerIpFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const configured =
    env.OPENCLAW_MAX_PREAUTH_CONNECTIONS_PER_IP ||
    (env.VITEST && env.OPENCLAW_TEST_MAX_PREAUTH_CONNECTIONS_PER_IP);
  if (!configured) {
    return DEFAULT_MAX_PREAUTH_CONNECTIONS_PER_IP;
  }
  const parsed = Number(configured);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return DEFAULT_MAX_PREAUTH_CONNECTIONS_PER_IP;
  }
  return Math.max(1, Math.floor(parsed));
}

export type PreauthConnectionBudget = {
  acquire(remoteAddr: string | undefined): boolean;
  release(remoteAddr: string | undefined): void;
};

export function createPreauthConnectionBudget(
  limit = getMaxPreauthConnectionsPerIpFromEnv(),
): PreauthConnectionBudget {
  const counts = new Map<string, number>();

  const normalizeIp = (remoteAddr: string | undefined): string | undefined => {
    return resolveClientIp({ remoteAddr });
  };

  return {
    acquire(remoteAddr) {
      const ip = normalizeIp(remoteAddr);
      if (!ip) {
        return true;
      }
      const next = (counts.get(ip) ?? 0) + 1;
      if (next > limit) {
        return false;
      }
      counts.set(ip, next);
      return true;
    },
    release(remoteAddr) {
      const ip = normalizeIp(remoteAddr);
      if (!ip) {
        return;
      }
      const current = counts.get(ip);
      if (current === undefined) {
        return;
      }
      if (current <= 1) {
        counts.delete(ip);
        return;
      }
      counts.set(ip, current - 1);
    },
  };
}
