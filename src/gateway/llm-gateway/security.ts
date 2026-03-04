/**
 * LLM Gateway Security Layer
 *
 * Hard policy gate, rate limiting, and kill switch
 */

import type {
  SecurityPolicy,
  SecurityCheckResult,
  RateLimitState,
  GatewayRequest,
  LLMGatewayConfig,
} from "./types.js";

/**
 * Rate limiter with sliding window
 */
export class RateLimiter {
  private state: RateLimitState;
  private policy: SecurityPolicy;

  constructor(policy: SecurityPolicy) {
    this.policy = policy;
    this.state = {
      minuteCount: 0,
      minuteResetAt: Date.now() + 60000,
      hourCount: 0,
      hourResetAt: Date.now() + 3600000,
      dailyCost: 0,
      dailyResetAt: Date.now() + 86400000,
    };
  }

  /**
   * Check and increment rate limit
   */
  check(): SecurityCheckResult {
    const now = Date.now();

    // Reset counters if windows expired
    if (now > this.state.minuteResetAt) {
      this.state.minuteCount = 0;
      this.state.minuteResetAt = now + 60000;
    }

    if (now > this.state.hourResetAt) {
      this.state.hourCount = 0;
      this.state.hourResetAt = now + 3600000;
    }

    if (now > this.state.dailyResetAt) {
      this.state.dailyCost = 0;
      this.state.dailyResetAt = now + 86400000;
    }

    // Check limits
    if (this.state.minuteCount >= this.policy.rateLimitPerMinute) {
      return {
        allowed: false,
        reason: "Rate limit exceeded: too many requests per minute",
        retryAfter: Math.ceil((this.state.minuteResetAt - now) / 1000),
      };
    }

    if (this.state.hourCount >= this.policy.rateLimitPerHour) {
      return {
        allowed: false,
        reason: "Rate limit exceeded: too many requests per hour",
        retryAfter: Math.ceil((this.state.hourResetAt - now) / 1000),
      };
    }

    if (this.state.dailyCost >= this.policy.dailyBudgetLimit) {
      return {
        allowed: false,
        reason: "Daily budget limit exceeded",
        retryAfter: Math.ceil((this.state.dailyResetAt - now) / 1000),
      };
    }

    // Increment counters
    this.state.minuteCount++;
    this.state.hourCount++;

    return { allowed: true };
  }

  /**
   * Record cost after request
   */
  recordCost(cost: number): void {
    this.state.dailyCost += cost;
  }

  /**
   * Get current state
   */
  getState(): RateLimitState {
    return { ...this.state };
  }

  /**
   * Reset all counters
   */
  reset(): void {
    const now = Date.now();
    this.state = {
      minuteCount: 0,
      minuteResetAt: now + 60000,
      hourCount: 0,
      hourResetAt: now + 3600000,
      dailyCost: 0,
      dailyResetAt: now + 86400000,
    };
  }
}

/**
 * Kill switch for emergency shutdown
 */
export class KillSwitch {
  private enabled: boolean;
  private reason: string | null = null;
  private activatedAt: number | null = null;

  constructor(initialState: boolean = false) {
    this.enabled = initialState;
  }

  /**
   * Check if kill switch is active
   */
  isActive(): boolean {
    return this.enabled;
  }

  /**
   * Activate kill switch
   */
  activate(reason: string): void {
    this.enabled = true;
    this.reason = reason;
    this.activatedAt = Date.now();
    console.error(`[LLM Gateway] Kill switch activated: ${reason}`);
  }

  /**
   * Deactivate kill switch
   */
  deactivate(): void {
    this.enabled = false;
    this.reason = null;
    this.activatedAt = null;
    console.log("[LLM Gateway] Kill switch deactivated");
  }

  /**
   * Get kill switch info
   */
  getInfo(): { enabled: boolean; reason: string | null; activatedAt: number | null } {
    return {
      enabled: this.enabled,
      reason: this.reason,
      activatedAt: this.activatedAt,
    };
  }
}

/**
 * Content policy checker
 */
export class ContentPolicy {
  private blockedPatterns: RegExp[];
  private allowedModels: Set<string>;
  private policy: SecurityPolicy;

  constructor(policy: SecurityPolicy) {
    this.policy = policy;
    this.blockedPatterns = policy.blockedPatterns.map((p) => new RegExp(p, "i"));
    this.allowedModels = new Set(policy.allowedModels);
  }

  /**
   * Check request against content policy
   */
  checkRequest(request: GatewayRequest): SecurityCheckResult {
    // Check model allowlist (even when model is omitted, use default model)
    if (!this.allowedModels.has("*")) {
      const effectiveModel = request.model || this.policy.defaultModel;
      if (effectiveModel && !this.allowedModels.has(effectiveModel)) {
        return {
          allowed: false,
          reason: `Model ${effectiveModel} is not in allowed list`,
        };
      }
    }

    // Check message content
    for (const msg of request.messages) {
      const content = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);

      for (const pattern of this.blockedPatterns) {
        if (pattern.test(content)) {
          return {
            allowed: false,
            reason: "Content blocked by security policy",
          };
        }
      }
    }

    return { allowed: true };
  }

  /**
   * Sanitize content for logging
   */
  sanitizeForLogging(content: string): string {
    // Remove potential secrets
    let sanitized = content;

    // API keys
    sanitized = sanitized.replace(/sk-[a-zA-Z0-9]{20,}/g, "sk-***REDACTED***");
    sanitized = sanitized.replace(/Bearer\s+[a-zA-Z0-9_-]+/gi, "Bearer ***REDACTED***");

    // Passwords
    sanitized = sanitized.replace(/password["\s]*[:=]["\s]*[^\s"']+/gi, "password=***REDACTED***");

    // Tokens
    sanitized = sanitized.replace(/token["\s]*[:=]["\s]*[^\s"']+/gi, "token=***REDACTED***");

    return sanitized;
  }
}

/**
 * Main security layer
 */
export class SecurityLayer {
  private policy: SecurityPolicy;
  private rateLimiter: RateLimiter;
  private killSwitch: KillSwitch;
  private contentPolicy: ContentPolicy;

  // Metrics
  private blockedRequests = 0;
  private allowedRequests = 0;

  constructor(config: LLMGatewayConfig) {
    this.policy = config.security;
    this.rateLimiter = new RateLimiter(config.security);
    this.killSwitch = new KillSwitch(config.security.killSwitchEnabled);
    this.contentPolicy = new ContentPolicy(config.security);
  }

  /**
   * Check if request is allowed
   */
  check(request: GatewayRequest): SecurityCheckResult {
    // Check kill switch
    if (this.killSwitch.isActive()) {
      this.blockedRequests++;
      const info = this.killSwitch.getInfo();
      return {
        allowed: false,
        reason: `Gateway is disabled: ${info.reason || "Kill switch active"}`,
      };
    }

    // Check hard policy gate
    if (this.policy.hardPolicyGate) {
      const policyResult = this.contentPolicy.checkRequest(request);
      if (!policyResult.allowed) {
        this.blockedRequests++;
        return policyResult;
      }
    }

    // Check rate limits
    if (this.policy.enabled) {
      const rateResult = this.rateLimiter.check();
      if (!rateResult.allowed) {
        this.blockedRequests++;
        return rateResult;
      }
    }

    this.allowedRequests++;
    return { allowed: true };
  }

  /**
   * Record cost after successful request
   */
  recordCost(cost: number): void {
    this.rateLimiter.recordCost(cost);
  }

  /**
   * Activate kill switch
   */
  activateKillSwitch(reason: string): void {
    this.killSwitch.activate(reason);
  }

  /**
   * Deactivate kill switch
   */
  deactivateKillSwitch(): void {
    this.killSwitch.deactivate();
  }

  /**
   * Get security status
   */
  getStatus(): {
    killSwitch: ReturnType<KillSwitch["getInfo"]>;
    rateLimit: RateLimitState;
    metrics: {
      blockedRequests: number;
      allowedRequests: number;
      blockRate: number;
    };
  } {
    const total = this.blockedRequests + this.allowedRequests;
    return {
      killSwitch: this.killSwitch.getInfo(),
      rateLimit: this.rateLimiter.getState(),
      metrics: {
        blockedRequests: this.blockedRequests,
        allowedRequests: this.allowedRequests,
        blockRate: total > 0 ? this.blockedRequests / total : 0,
      },
    };
  }

  /**
   * Reset rate limits
   */
  resetRateLimits(): void {
    this.rateLimiter.reset();
  }

  /**
   * Sanitize content for logging
   */
  sanitizeForLogging(content: string): string {
    return this.contentPolicy.sanitizeForLogging(content);
  }
}

/**
 * Create security middleware for Express/Fastify
 */
export function createSecurityMiddleware(security: SecurityLayer) {
  return async (req: Record<string, unknown>, res: Record<string, unknown>, next: () => void) => {
    const request: GatewayRequest = req.body as GatewayRequest;

    const result = security.check(request);

    if (!result.allowed) {
      const resObj = res as { status: (code: number) => { json: (data: unknown) => void } };
      resObj.status(429).json({
        error: "Too Many Requests",
        message: result.reason,
        retryAfter: result.retryAfter,
      });
      return;
    }

    // Add security context to request
    req.securityContext = {
      checkTime: Date.now(),
    };

    next();
  };
}
