/**
 * Rate limiter middleware with sliding window algorithm.
 *
 * Supports per-key limits (IP, user ID, API key), configurable backends
 * (in-memory or Redis-compatible), bypass rules, and standard rate-limit
 * response headers.
 */

// ── Types ─────────────────────────────────────────────────────────────

export interface RateLimitBackend {
  /** Record a hit and return the updated window info. */
  hit(key: string, windowMs: number, now?: number): Promise<WindowInfo>;
  /** Peek at current window without recording a hit. */
  peek(key: string, windowMs: number, now?: number): Promise<WindowInfo>;
  /** Reset all entries for a key. */
  reset(key: string): Promise<void>;
}

export interface WindowInfo {
  /** Total number of hits in the current window. */
  count: number;
  /** Unix-ms timestamp when the oldest entry in the window expires. */
  resetAt: number;
}

export interface RateLimitRule {
  /** Maximum number of requests allowed in the window. */
  limit: number;
  /** Window duration in milliseconds. */
  windowMs: number;
}

export type KeyExtractor = (req: RateLimitRequest) => string | null;

export interface RateLimitRequest {
  ip?: string;
  headers?: Record<string, string | string[] | undefined>;
  userId?: string;
  apiKey?: string;
  path?: string;
  method?: string;
}

export interface RateLimitResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

export interface RateLimiterOptions {
  /** Default rule applied when no per-key override matches. */
  defaultRule: RateLimitRule;
  /** Per-key rule overrides (key pattern → rule). */
  keyRules?: Map<string, RateLimitRule>;
  /** How to derive the rate-limit key from a request. Default: by IP. */
  keyExtractor?: KeyExtractor;
  /** Backend for storing window state. Default: in-memory. */
  backend?: RateLimitBackend;
  /** Keys that bypass rate limiting entirely. */
  bypassKeys?: Set<string>;
  /** Custom status code for rate-limited responses (default 429). */
  statusCode?: number;
  /** Custom message body for rate-limited responses. */
  message?: string;
  /** Whether to include Retry-After header (default true). */
  includeRetryAfter?: boolean;
}

// ── In-memory backend ─────────────────────────────────────────────────

interface SlidingWindowEntry {
  timestamps: number[];
}

export class InMemoryBackend implements RateLimitBackend {
  private store = new Map<string, SlidingWindowEntry>();
  private gcIntervalId: ReturnType<typeof setInterval> | null = null;
  private readonly gcIntervalMs: number;

  constructor(gcIntervalMs = 60_000) {
    this.gcIntervalMs = gcIntervalMs;
    this.startGC();
  }

  async hit(key: string, windowMs: number, now = Date.now()): Promise<WindowInfo> {
    const entry = this.getOrCreate(key);
    this.evict(entry, now, windowMs);
    entry.timestamps.push(now);
    return {
      count: entry.timestamps.length,
      resetAt: entry.timestamps[0]! + windowMs,
    };
  }

  async peek(key: string, windowMs: number, now = Date.now()): Promise<WindowInfo> {
    const entry = this.store.get(key);
    if (!entry || entry.timestamps.length === 0) {
      return { count: 0, resetAt: now + windowMs };
    }
    const cutoff = now - windowMs;
    const active = entry.timestamps.filter((t) => t > cutoff);
    return {
      count: active.length,
      resetAt: active.length > 0 ? active[0]! + windowMs : now + windowMs,
    };
  }

  async reset(key: string): Promise<void> {
    this.store.delete(key);
  }

  /** Stop the GC timer (for clean shutdown in tests). */
  destroy(): void {
    if (this.gcIntervalId !== null) {
      clearInterval(this.gcIntervalId);
      this.gcIntervalId = null;
    }
  }

  private getOrCreate(key: string): SlidingWindowEntry {
    let entry = this.store.get(key);
    if (!entry) {
      entry = { timestamps: [] };
      this.store.set(key, entry);
    }
    return entry;
  }

  private evict(entry: SlidingWindowEntry, now: number, windowMs: number): void {
    const cutoff = now - windowMs;
    while (entry.timestamps.length > 0 && entry.timestamps[0]! <= cutoff) {
      entry.timestamps.shift();
    }
  }

  private startGC(): void {
    this.gcIntervalId = setInterval(() => {
      const now = Date.now();
      for (const [key, entry] of this.store) {
        if (entry.timestamps.length === 0) {
          this.store.delete(key);
          continue;
        }
        const newest = entry.timestamps[entry.timestamps.length - 1]!;
        // Remove entries that are older than 5 minutes with no activity
        if (now - newest > 300_000) {
          this.store.delete(key);
        }
      }
    }, this.gcIntervalMs);

    // Allow the Node.js process to exit even if the timer is active
    if (this.gcIntervalId && typeof this.gcIntervalId === 'object' && 'unref' in this.gcIntervalId) {
      this.gcIntervalId.unref();
    }
  }
}

// ── Key extractors ────────────────────────────────────────────────────

export const keyExtractors = {
  byIP: ((req: RateLimitRequest) => req.ip ?? null) as KeyExtractor,

  byUserId: ((req: RateLimitRequest) => req.userId ?? null) as KeyExtractor,

  byApiKey: ((req: RateLimitRequest) => {
    if (req.apiKey) return req.apiKey;
    const header = req.headers?.['x-api-key'];
    if (typeof header === 'string') return header;
    return null;
  }) as KeyExtractor,

  byIPAndPath: ((req: RateLimitRequest) => {
    const ip = req.ip ?? 'unknown';
    const path = req.path ?? '/';
    return `${ip}:${path}`;
  }) as KeyExtractor,
};

// ── Rate-limit header helpers ─────────────────────────────────────────

function buildRateLimitHeaders(
  limit: number,
  remaining: number,
  resetAt: number,
  includeRetryAfter: boolean,
): Record<string, string> {
  const headers: Record<string, string> = {
    'X-RateLimit-Limit': String(limit),
    'X-RateLimit-Remaining': String(Math.max(0, remaining)),
    'X-RateLimit-Reset': String(Math.ceil(resetAt / 1000)),
  };
  if (includeRetryAfter && remaining <= 0) {
    const retryAfterSec = Math.max(1, Math.ceil((resetAt - Date.now()) / 1000));
    headers['Retry-After'] = String(retryAfterSec);
  }
  return headers;
}

// ── Middleware ─────────────────────────────────────────────────────────

export interface RateLimitResult {
  allowed: boolean;
  response?: RateLimitResponse;
  headers: Record<string, string>;
}

/**
 * Create a rate limiter function.
 *
 * Returns an async function that, given a request object, resolves to a
 * {@link RateLimitResult} indicating whether the request is allowed and
 * providing the appropriate response headers.
 */
export function createRateLimiter(options: RateLimiterOptions) {
  const {
    defaultRule,
    keyRules = new Map<string, RateLimitRule>(),
    keyExtractor = keyExtractors.byIP,
    backend = new InMemoryBackend(),
    bypassKeys = new Set<string>(),
    statusCode = 429,
    message = 'Too Many Requests',
    includeRetryAfter = true,
  } = options;

  function getRuleForKey(key: string): RateLimitRule {
    for (const [pattern, rule] of keyRules) {
      if (key === pattern || key.startsWith(pattern + ':')) {
        return rule;
      }
    }
    return defaultRule;
  }

  return async function rateLimit(req: RateLimitRequest): Promise<RateLimitResult> {
    const key = keyExtractor(req);
    if (key === null) {
      // Cannot identify the client — allow the request but emit no headers
      return { allowed: true, headers: {} };
    }

    // Check bypass list
    if (bypassKeys.has(key)) {
      return {
        allowed: true,
        headers: buildRateLimitHeaders(
          defaultRule.limit,
          defaultRule.limit,
          Date.now() + defaultRule.windowMs,
          false,
        ),
      };
    }

    const rule = getRuleForKey(key);
    const windowInfo = await backend.hit(key, rule.windowMs);
    const remaining = rule.limit - windowInfo.count;

    const headers = buildRateLimitHeaders(
      rule.limit,
      remaining,
      windowInfo.resetAt,
      includeRetryAfter,
    );

    if (remaining < 0) {
      return {
        allowed: false,
        headers,
        response: {
          statusCode,
          headers: {
            ...headers,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            error: message,
            retryAfter: headers['Retry-After'] ?? null,
          }),
        },
      };
    }

    return { allowed: true, headers };
  };
}
