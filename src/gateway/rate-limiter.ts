import type { IncomingMessage } from "node:http";
import { resolveGatewayClientIp } from "./net.js";

export interface RateLimitConfig {
  maxRequests: number;
  windowMs: number;
  backoffMultiplier?: number;
  maxBackoffMs?: number;
}

export interface RateLimitEndpointConfig {
  auth?: Partial<RateLimitConfig>;
  chatCompletions?: Partial<RateLimitConfig>;
  toolsInvoke?: Partial<RateLimitConfig>;
  responses?: Partial<RateLimitConfig>;
  hooks?: Partial<RateLimitConfig>;
  default?: Partial<RateLimitConfig>;
}

interface ClientRateState {
  /** Per-endpoint request counters: endpoint -> { count, windowStart } */
  endpoints: Map<string, { count: number; windowStart: number }>;
  failedAuthAttempts: number;
  authBackoffUntil: number;
}

interface RateLimitResult {
  allowed: boolean;
  reason?: "rate_limit" | "auth_backoff";
  retryAfter?: number;
}

const AUTH_DEFAULTS: Required<RateLimitConfig> = {
  maxRequests: 10,
  windowMs: 60_000,
  backoffMultiplier: 2,
  maxBackoffMs: 300_000,
};

const GENERAL_DEFAULTS: Pick<RateLimitConfig, "maxRequests" | "windowMs"> = {
  maxRequests: 100,
  windowMs: 60_000,
};

function headerValue(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

export class GatewayRateLimiter {
  private readonly clients = new Map<string, ClientRateState>();
  private readonly endpointConfigs: Record<
    string,
    Required<Pick<RateLimitConfig, "maxRequests" | "windowMs">>
  >;
  private readonly authConfig: Required<RateLimitConfig>;
  private readonly cleanupInterval: NodeJS.Timeout;
  private readonly maxClients: number;

  constructor(config: RateLimitEndpointConfig, options?: { maxClients?: number }) {
    this.authConfig = {
      maxRequests: config.auth?.maxRequests ?? AUTH_DEFAULTS.maxRequests,
      windowMs: config.auth?.windowMs ?? AUTH_DEFAULTS.windowMs,
      backoffMultiplier: config.auth?.backoffMultiplier ?? AUTH_DEFAULTS.backoffMultiplier,
      maxBackoffMs: config.auth?.maxBackoffMs ?? AUTH_DEFAULTS.maxBackoffMs,
    };

    this.endpointConfigs = {
      auth: { maxRequests: this.authConfig.maxRequests, windowMs: this.authConfig.windowMs },
      chatCompletions: {
        maxRequests: config.chatCompletions?.maxRequests ?? GENERAL_DEFAULTS.maxRequests,
        windowMs: config.chatCompletions?.windowMs ?? GENERAL_DEFAULTS.windowMs,
      },
      toolsInvoke: {
        maxRequests: config.toolsInvoke?.maxRequests ?? 60,
        windowMs: config.toolsInvoke?.windowMs ?? GENERAL_DEFAULTS.windowMs,
      },
      responses: {
        maxRequests: config.responses?.maxRequests ?? 60,
        windowMs: config.responses?.windowMs ?? GENERAL_DEFAULTS.windowMs,
      },
      hooks: {
        maxRequests: config.hooks?.maxRequests ?? 30,
        windowMs: config.hooks?.windowMs ?? GENERAL_DEFAULTS.windowMs,
      },
      default: {
        maxRequests: config.default?.maxRequests ?? GENERAL_DEFAULTS.maxRequests,
        windowMs: config.default?.windowMs ?? GENERAL_DEFAULTS.windowMs,
      },
    };

    this.validateConfig();
    this.maxClients = options?.maxClients ?? 100_000;

    this.cleanupInterval = setInterval(() => this.cleanup(), 60_000);
    this.cleanupInterval.unref();
  }

  checkRateLimit(params: {
    req: IncomingMessage;
    trustedProxies?: string[];
    endpoint: keyof RateLimitEndpointConfig;
  }): RateLimitResult {
    const { req, trustedProxies, endpoint } = params;
    const clientIp = this.resolveIp(req, trustedProxies);
    if (!clientIp) {
      return { allowed: true };
    }

    const config = this.endpointConfigs[endpoint] ?? this.endpointConfigs.default;
    const now = Date.now();
    const state = this.getOrCreateClientState(clientIp);

    // Check auth backoff for auth endpoint
    if (endpoint === "auth" && now < state.authBackoffUntil) {
      const retryAfter = Math.ceil((state.authBackoffUntil - now) / 1000);
      return { allowed: false, reason: "auth_backoff", retryAfter };
    }

    // Per-endpoint sliding window counter
    let epState = state.endpoints.get(endpoint);
    if (!epState) {
      epState = { count: 0, windowStart: now };
      state.endpoints.set(endpoint, epState);
    }

    if (now - epState.windowStart >= config.windowMs) {
      epState.count = 0;
      epState.windowStart = now;
    }

    if (++epState.count > config.maxRequests) {
      const retryAfterMs = config.windowMs - (now - epState.windowStart);
      return { allowed: false, reason: "rate_limit", retryAfter: Math.ceil(retryAfterMs / 1000) };
    }

    return { allowed: true };
  }

  /**
   * Check only auth backoff state without incrementing any counters.
   * Used at the HTTP layer to reject requests from IPs in backoff before routing.
   */
  checkAuthBackoff(params: { req: IncomingMessage; trustedProxies?: string[] }): RateLimitResult {
    const clientIp = this.resolveIp(params.req, params.trustedProxies);
    if (!clientIp) {
      return { allowed: true };
    }

    const state = this.clients.get(clientIp);
    if (!state) {
      return { allowed: true };
    }

    const now = Date.now();
    if (now < state.authBackoffUntil) {
      const retryAfter = Math.ceil((state.authBackoffUntil - now) / 1000);
      return { allowed: false, reason: "auth_backoff", retryAfter };
    }

    return { allowed: true };
  }

  recordFailedAuth(params: { req: IncomingMessage; trustedProxies?: string[] }): void {
    const clientIp = this.resolveIp(params.req, params.trustedProxies);
    if (!clientIp) {
      return;
    }

    const now = Date.now();
    const state = this.getOrCreateClientState(clientIp);
    state.failedAuthAttempts++;

    const multiplier = this.authConfig.backoffMultiplier;
    const backoffMs = Math.min(
      1000 * Math.pow(multiplier, state.failedAuthAttempts - 1),
      this.authConfig.maxBackoffMs,
    );
    state.authBackoffUntil = now + backoffMs;
  }

  resetFailedAuth(params: { req: IncomingMessage; trustedProxies?: string[] }): void {
    const clientIp = this.resolveIp(params.req, params.trustedProxies);
    if (!clientIp) {
      return;
    }

    const state = this.clients.get(clientIp);
    if (state) {
      state.failedAuthAttempts = 0;
      state.authBackoffUntil = 0;
    }
  }

  getClientStats(params: {
    req: IncomingMessage;
    trustedProxies?: string[];
  }): { count: number; failedAuthAttempts: number } | null {
    const clientIp = this.resolveIp(params.req, params.trustedProxies);
    if (!clientIp) {
      return null;
    }

    const state = this.clients.get(clientIp);
    if (!state) {
      return null;
    }

    let totalCount = 0;
    for (const ep of state.endpoints.values()) {
      totalCount += ep.count;
    }
    return { count: totalCount, failedAuthAttempts: state.failedAuthAttempts };
  }

  destroy(): void {
    clearInterval(this.cleanupInterval);
    this.clients.clear();
  }

  private resolveIp(req: IncomingMessage, trustedProxies?: string[]): string | undefined {
    return resolveGatewayClientIp({
      remoteAddr: req.socket?.remoteAddress ?? "",
      forwardedFor: headerValue(req.headers["x-forwarded-for"]),
      realIp: headerValue(req.headers["x-real-ip"]),
      trustedProxies,
    });
  }

  private getOrCreateClientState(clientIp: string): ClientRateState {
    let state = this.clients.get(clientIp);
    if (!state) {
      if (this.clients.size >= this.maxClients) {
        this.evictOldestEntries(Math.floor(this.maxClients * 0.1));
      }
      state = {
        endpoints: new Map(),
        failedAuthAttempts: 0,
        authBackoffUntil: 0,
      };
      this.clients.set(clientIp, state);
    }
    return state;
  }

  private evictOldestEntries(count: number): void {
    const keys = Array.from(this.clients.keys()).slice(0, count);
    for (const key of keys) {
      this.clients.delete(key);
    }
  }

  private cleanup(): void {
    const now = Date.now();
    const maxAge = Math.max(
      ...Object.values(this.endpointConfigs).map((c) => c.windowMs),
      this.authConfig.maxBackoffMs,
    );

    for (const [ip, state] of this.clients) {
      const oldestWindow = Math.min(
        ...Array.from(state.endpoints.values()).map((e) => e.windowStart),
        Infinity,
      );
      if (now - oldestWindow > maxAge && now > state.authBackoffUntil) {
        this.clients.delete(ip);
      }
    }
  }

  private validateConfig(): void {
    for (const [name, config] of Object.entries(this.endpointConfigs)) {
      if (config.maxRequests < 1) {
        throw new Error(`${name}.maxRequests must be at least 1, got: ${config.maxRequests}`);
      }
      if (config.windowMs < 1000) {
        throw new Error(`${name}.windowMs must be at least 1000ms, got: ${config.windowMs}`);
      }
    }
    if (this.authConfig.backoffMultiplier < 1) {
      throw new Error(
        `auth.backoffMultiplier must be at least 1, got: ${this.authConfig.backoffMultiplier}`,
      );
    }
    if (this.authConfig.maxBackoffMs < 1000) {
      throw new Error(
        `auth.maxBackoffMs must be at least 1000ms, got: ${this.authConfig.maxBackoffMs}`,
      );
    }
  }
}
