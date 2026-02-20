import { EventEmitter } from "events";

/**
 * Circuit Breaker — Phase 2: Reliability Layer
 *
 * Prevents cascade failures by stopping requests when error threshold exceeded.
 * Implements the standard circuit breaker pattern with CLOSED/OPEN/HALF_OPEN states.
 */

export type CircuitState = "CLOSED" | "OPEN" | "HALF_OPEN";

export interface CircuitBreakerConfig {
  /** Name for identification */
  name: string;
  /** Failure threshold before opening circuit */
  failureThreshold: number;
  /** Time window for counting failures (ms) */
  failureWindowMs: number;
  /** Cooldown period before allowing test requests */
  resetTimeoutMs: number;
  /** Success threshold in HALF_OPEN to close circuit */
  successThreshold: number;
  /** Half-open request rate (1 in N requests allowed) */
  halfOpenRate: number;
}

export interface CircuitBreakerMetrics {
  state: CircuitState;
  failures: number;
  successes: number;
  lastFailureTime: number | null;
  lastSuccessTime: number | null;
  consecutiveSuccesses: number;
  totalRequests: number;
  totalFailures: number;
}

const DEFAULT_CONFIG: CircuitBreakerConfig = {
  name: "default",
  failureThreshold: 5,
  failureWindowMs: 60000,
  resetTimeoutMs: 30000,
  successThreshold: 3,
  halfOpenRate: 10,
};

/**
 * Circuit breaker for LLM API calls
 */
export class CircuitBreaker extends EventEmitter {
  private config: CircuitBreakerConfig;
  private state: CircuitState = "CLOSED";
  private failures: number[] = [];
  private successes: number[] = [];
  private lastFailureTime: number | null = null;
  private lastSuccessTime: number | null = null;
  private consecutiveSuccesses = 0;
  private totalRequests = 0;
  private totalFailures = 0;
  private halfOpenRequestCount = 0;

  constructor(config: Partial<CircuitBreakerConfig> = {}) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Execute a function with circuit breaker protection
   */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === "OPEN") {
      if (this.shouldAttemptReset()) {
        this.transitionTo("HALF_OPEN");
      } else {
        throw new CircuitBreakerError(
          `Circuit breaker '${this.config.name}' is OPEN`,
          this.config.name,
          this.state,
          this.getRetryAfterMs(),
        );
      }
    }

    if (this.state === "HALF_OPEN") {
      this.halfOpenRequestCount++;
      if (this.halfOpenRequestCount % this.config.halfOpenRate !== 0) {
        throw new CircuitBreakerError(
          `Circuit breaker '${this.config.name}' is HALF_OPEN (request throttled)`,
          this.config.name,
          this.state,
          this.config.resetTimeoutMs,
        );
      }
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  /**
   * Record a successful request
   */
  onSuccess(): void {
    const now = Date.now();
    this.successes.push(now);
    this.cleanupOldEntries(this.successes);
    this.lastSuccessTime = now;
    this.totalRequests++;

    if (this.state === "HALF_OPEN") {
      this.consecutiveSuccesses++;
      if (this.consecutiveSuccesses >= this.config.successThreshold) {
        this.transitionTo("CLOSED");
      }
    }

    this.emit("success", { name: this.config.name, timestamp: now });
  }

  /**
   * Record a failed request
   */
  onFailure(): void {
    const now = Date.now();
    this.failures.push(now);
    this.cleanupOldEntries(this.failures);
    this.lastFailureTime = now;
    this.totalRequests++;
    this.totalFailures++;

    if (this.state === "HALF_OPEN") {
      this.consecutiveSuccesses = 0;
      this.transitionTo("OPEN");
    } else if (this.state === "CLOSED" && this.getFailureCount() >= this.config.failureThreshold) {
      this.transitionTo("OPEN");
    }

    this.emit("failure", {
      name: this.config.name,
      timestamp: now,
      failureCount: this.getFailureCount(),
    });
  }

  /**
   * Get current metrics
   */
  getMetrics(): CircuitBreakerMetrics {
    return {
      state: this.state,
      failures: this.getFailureCount(),
      successes: this.successes.length,
      lastFailureTime: this.lastFailureTime,
      lastSuccessTime: this.lastSuccessTime,
      consecutiveSuccesses: this.consecutiveSuccesses,
      totalRequests: this.totalRequests,
      totalFailures: this.totalFailures,
    };
  }

  /**
   * Get current state
   */
  getState(): CircuitState {
    return this.state;
  }

  /**
   * Force circuit to CLOSED (for testing/recovery)
   */
  forceClose(): void {
    this.transitionTo("CLOSED");
  }

  /**
   * Force circuit to OPEN (for testing)
   */
  forceOpen(): void {
    this.transitionTo("OPEN");
  }

  /**
   * Get time until next retry attempt (ms)
   */
  getRetryAfterMs(): number {
    if (this.state !== "OPEN" || !this.lastFailureTime) {
      return 0;
    }
    const elapsed = Date.now() - this.lastFailureTime;
    return Math.max(0, this.config.resetTimeoutMs - elapsed);
  }

  private getFailureCount(): number {
    this.cleanupOldEntries(this.failures);
    return this.failures.length;
  }

  private cleanupOldEntries(entries: number[]): void {
    const cutoff = Date.now() - this.config.failureWindowMs;
    while (entries.length > 0 && entries[0] < cutoff) {
      entries.shift();
    }
  }

  private shouldAttemptReset(): boolean {
    if (!this.lastFailureTime) {
      return true;
    }
    return Date.now() - this.lastFailureTime >= this.config.resetTimeoutMs;
  }

  private transitionTo(newState: CircuitState): void {
    const oldState = this.state;
    this.state = newState;

    if (newState === "CLOSED") {
      this.failures = [];
      this.consecutiveSuccesses = 0;
      this.halfOpenRequestCount = 0;
    } else if (newState === "HALF_OPEN") {
      this.consecutiveSuccesses = 0;
      this.halfOpenRequestCount = 0;
    }

    this.emit("stateChange", {
      name: this.config.name,
      from: oldState,
      to: newState,
    });
  }
}

/**
 * Circuit breaker error with retry information
 */
export class CircuitBreakerError extends Error {
  constructor(
    message: string,
    public readonly breakerName: string,
    public readonly state: CircuitState,
    public readonly retryAfterMs: number,
  ) {
    super(message);
    this.name = "CircuitBreakerError";
  }
}

/**
 * Factory for creating pre-configured circuit breakers
 */
export const CircuitBreakers = {
  /** For Gemini API calls */
  gemini: () =>
    new CircuitBreaker({
      name: "gemini",
      failureThreshold: 5,
      failureWindowMs: 60000,
      resetTimeoutMs: 30000,
      successThreshold: 3,
      halfOpenRate: 10,
    }),

  /** For OpenAI API calls */
  openai: () =>
    new CircuitBreaker({
      name: "openai",
      failureThreshold: 5,
      failureWindowMs: 60000,
      resetTimeoutMs: 30000,
      successThreshold: 3,
      halfOpenRate: 10,
    }),

  /** For Anthropic API calls */
  anthropic: () =>
    new CircuitBreaker({
      name: "anthropic",
      failureThreshold: 5,
      failureWindowMs: 60000,
      resetTimeoutMs: 30000,
      successThreshold: 3,
      halfOpenRate: 10,
    }),

  /** Strict: opens after 2 failures */
  strict: (name: string) =>
    new CircuitBreaker({
      name,
      failureThreshold: 2,
      failureWindowMs: 30000,
      resetTimeoutMs: 60000,
      successThreshold: 5,
      halfOpenRate: 20,
    }),

  /** Lenient: opens after 10 failures */
  lenient: (name: string) =>
    new CircuitBreaker({
      name,
      failureThreshold: 10,
      failureWindowMs: 120000,
      resetTimeoutMs: 15000,
      successThreshold: 2,
      halfOpenRate: 5,
    }),
};
