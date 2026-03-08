/**
 * Pre-auth WebSocket connection limiter.
 *
 * Addresses T-IMPACT-002: resource exhaustion via connection flood.
 *
 * Standalone module — wire into the WebSocket upgrade handler in
 * a follow-up integration PR.
 */

interface WsLimitConfig {
  maxPendingPerIp: number;
  challengeTimeoutMs: number;
  enabled: boolean;
  /** IPs of trusted reverse proxies. Only these may set x-forwarded-for. */
  trustedProxies?: string[];
}

const DEFAULT_CONFIG: WsLimitConfig = {
  maxPendingPerIp: 10,
  challengeTimeoutMs: 30_000,
  enabled: true,
};

function getIp(req: any, trustedProxies: string[]): string {
  const peerIp = req.socket?.remoteAddress || "unknown";

  if (trustedProxies.length > 0 && trustedProxies.includes(peerIp)) {
    const forwarded = req.headers["x-forwarded-for"];
    if (typeof forwarded === "string") {
      return forwarded.split(",")[0].trim();
    }
  }

  return peerIp;
}

export function createWsConnectionLimiter(userConfig?: Partial<WsLimitConfig>) {
  const config = { ...DEFAULT_CONFIG, ...userConfig };
  const trustedProxies = config.trustedProxies ?? [];

  const pending = new Map<string, number>();
  const timers = new Map<object, ReturnType<typeof setTimeout>>();

  return {
    /**
     * Call when a new WebSocket connection is opened (before auth).
     * Returns false if the connection should be rejected.
     * Starts a challenge timeout — calls onTimeout if auth is not
     * completed in time.
     */
    onConnect(req: any, onTimeout: () => void): boolean {
      if (!config.enabled) return true;

      const ip = getIp(req, trustedProxies);
      const current = pending.get(ip) || 0;

      if (current >= config.maxPendingPerIp) {
        return false;
      }

      pending.set(ip, current + 1);

      const timer = setTimeout(() => {
        timers.delete(req);
        const count = pending.get(ip) || 0;
        if (count <= 1) {
          pending.delete(ip);
        } else {
          pending.set(ip, count - 1);
        }
        onTimeout();
      }, config.challengeTimeoutMs);

      if (timer.unref) timer.unref();
      timers.set(req, timer);

      return true;
    },

    /**
     * Call when a connection completes auth or disconnects cleanly.
     * Only decrements if the timeout has not already fired.
     */
    onResolved(req: any): void {
      const timer = timers.get(req);
      if (timer) {
        clearTimeout(timer);
        timers.delete(req);

        const ip = getIp(req, trustedProxies);
        const current = pending.get(ip) || 0;
        if (current <= 1) {
          pending.delete(ip);
        } else {
          pending.set(ip, current - 1);
        }
      }
      // If no timer exists, the timeout already fired and decremented.
      // Do nothing to avoid double-decrement.
    },

    pendingFor(ip: string): number {
      return pending.get(ip) || 0;
    },

    get challengeTimeoutMs(): number {
      return config.challengeTimeoutMs;
    },
  };
}
