/**
 * Adds X-RateLimit-* response headers to HTTP responses.
 *
 * T-IMPACT-002: gateway responses contain no rate limiting metadata.
 * Headers follow the IETF draft-polli-ratelimit convention.
 *
 * Standalone module — wire into the HTTP handler chain in a
 * follow-up integration PR.
 */

interface RateLimitHeadersConfig {
  limit: number;
  windowSecs: number;
  enabled: boolean;
  /** IPs of trusted reverse proxies. Only these may set x-forwarded-for. */
  trustedProxies?: string[];
}

interface ClientWindow {
  timestamps: number[];
}

const DEFAULT_CONFIG: RateLimitHeadersConfig = {
  limit: 120,
  windowSecs: 60,
  enabled: true,
};

export function createRateLimitHeaders(
  userConfig?: Partial<RateLimitHeadersConfig>,
) {
  const config = { ...DEFAULT_CONFIG, ...userConfig };
  const windowMs = config.windowSecs * 1000;
  const trustedProxies = config.trustedProxies ?? [];
  const clients = new Map<string, ClientWindow>();

  const cleanupTimer = setInterval(() => {
    const cutoff = Date.now() - windowMs;
    for (const [key, client] of clients) {
      client.timestamps = client.timestamps.filter((t) => t > cutoff);
      if (client.timestamps.length === 0) {
        clients.delete(key);
      }
    }
  }, 300_000);

  if (cleanupTimer.unref) cleanupTimer.unref();

  function getClientKey(req: any): string {
    const peerIp = req.socket?.remoteAddress || "unknown";

    if (trustedProxies.length > 0 && trustedProxies.includes(peerIp)) {
      const forwarded = req.headers["x-forwarded-for"];
      if (typeof forwarded === "string") {
        return forwarded.split(",")[0].trim();
      }
    }

    return peerIp;
  }

  return {
    applyHeaders(req: any, res: any): boolean {
      if (!config.enabled) return true;

      const key = getClientKey(req);
      const now = Date.now();
      const cutoff = now - windowMs;

      let client = clients.get(key);
      if (!client) {
        client = { timestamps: [] };
        clients.set(key, client);
      }

      client.timestamps = client.timestamps.filter((t) => t > cutoff);
      client.timestamps.push(now);

      const remaining = Math.max(0, config.limit - client.timestamps.length);

      const oldestInWindow = client.timestamps[0];
      const resetAt = oldestInWindow + windowMs;
      const resetSecs = Math.max(1, Math.ceil((resetAt - now) / 1000));

      res.setHeader("X-RateLimit-Limit", String(config.limit));
      res.setHeader("X-RateLimit-Remaining", String(remaining));
      res.setHeader("X-RateLimit-Reset", String(resetSecs));

      if (remaining === 0) {
        res.setHeader("Retry-After", String(resetSecs));
        return false;
      }

      return true;
    },

    /** Cancel the cleanup timer. Call in tests or on shutdown. */
    destroy(): void {
      clearInterval(cleanupTimer);
    },
  };
}
