import { EventEmitter } from "events";

/**
 * Error Tracker — Phase 2: Observability Layer
 *
 * Tracks LLM API error rates, latencies, and failure patterns.
 * Provides metrics for circuit breaker decisions and alerting.
 */

// ============================================================================
// Types
// ============================================================================

export type ErrorCategory =
  | "timeout"
  | "rate_limit"
  | "auth"
  | "validation"
  | "content_policy"
  | "server_error"
  | "network"
  | "unknown";

export interface TrackedError {
  id: string;
  timestamp: number;
  category: ErrorCategory;
  message: string;
  provider: string;
  model: string;
  latencyMs?: number;
  retryCount: number;
  context?: Record<string, unknown>;
}

export interface ErrorMetrics {
  totalRequests: number;
  totalErrors: number;
  errorRate: number;
  errorsByCategory: Record<ErrorCategory, number>;
  errorsByProvider: Record<string, number>;
  averageLatencyMs: number;
  p95LatencyMs: number;
  p99LatencyMs: number;
  consecutiveErrors: number;
  timeWindowMs: number;
}

export interface ErrorTrackerConfig {
  /** Time window for metrics (ms) */
  timeWindowMs: number;
  /** Alert threshold for error rate (0-1) */
  errorRateThreshold: number;
  /** Alert threshold for consecutive errors */
  consecutiveErrorThreshold: number;
  /** Alert threshold for latency (ms) */
  latencyThresholdMs: number;
  /** Enable detailed logging */
  detailedLogging: boolean;
  /** Maximum errors to store in memory */
  maxStoredErrors: number;
}

const DEFAULT_CONFIG: ErrorTrackerConfig = {
  timeWindowMs: 300000, // 5 minutes
  errorRateThreshold: 0.05, // 5%
  consecutiveErrorThreshold: 5,
  latencyThresholdMs: 10000, // 10 seconds
  detailedLogging: true,
  maxStoredErrors: 1000,
};

// ============================================================================
// Error Tracker
// ============================================================================

export class ErrorTracker extends EventEmitter {
  private config: ErrorTrackerConfig;
  private errors: TrackedError[] = [];
  private successes: { timestamp: number; latencyMs: number; provider: string }[] = [];
  private consecutiveErrors = 0;
  private lastSuccessTime: number | null = null;

  constructor(config: Partial<ErrorTrackerConfig> = {}) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Track a successful request
   */
  trackSuccess(provider: string, model: string, latencyMs: number): void {
    const now = Date.now();
    this.successes.push({ timestamp: now, latencyMs, provider });
    this.cleanup();

    this.consecutiveErrors = 0;
    this.lastSuccessTime = now;

    // Check for latency threshold breach
    if (latencyMs > this.config.latencyThresholdMs) {
      this.emit("latencyAlert", {
        provider,
        model,
        latencyMs,
        thresholdMs: this.config.latencyThresholdMs,
      });
    }

    if (this.config.detailedLogging) {
      console.log(`[ErrorTracker] Success: ${provider}/${model} in ${latencyMs}ms`);
    }
  }

  /**
   * Track an error
   */
  trackError(
    error: Error,
    provider: string,
    model: string,
    context?: Record<string, unknown>,
  ): TrackedError {
    const category = this.categorizeError(error);
    const trackedError: TrackedError = {
      id: this.generateId(),
      timestamp: Date.now(),
      category,
      message: error.message,
      provider,
      model,
      latencyMs: context?.latencyMs as number | undefined,
      retryCount: (context?.retryCount as number) ?? 0,
      context,
    };

    this.errors.push(trackedError);
    this.cleanup();

    this.consecutiveErrors++;

    // Emit error event
    this.emit("error", trackedError);

    // Check alert thresholds
    this.checkThresholds(trackedError);

    if (this.config.detailedLogging) {
      console.error(`[ErrorTracker] Error: ${category} - ${error.message} (${provider}/${model})`);
    }

    return trackedError;
  }

  /**
   * Get current metrics
   */
  getMetrics(): ErrorMetrics {
    this.cleanup();

    const now = Date.now();
    const windowStart = now - this.config.timeWindowMs;

    const recentErrors = this.errors.filter((e) => e.timestamp >= windowStart);
    const recentSuccesses = this.successes.filter((s) => s.timestamp >= windowStart);

    const totalRequests = recentErrors.length + recentSuccesses.length;
    const totalErrors = recentErrors.length;
    const errorRate = totalRequests > 0 ? totalErrors / totalRequests : 0;

    // Errors by category
    const errorsByCategory: Record<ErrorCategory, number> = {
      timeout: 0,
      rate_limit: 0,
      auth: 0,
      validation: 0,
      content_policy: 0,
      server_error: 0,
      network: 0,
      unknown: 0,
    };
    for (const error of recentErrors) {
      errorsByCategory[error.category]++;
    }

    // Errors by provider
    const errorsByProvider: Record<string, number> = {};
    for (const error of recentErrors) {
      errorsByProvider[error.provider] = (errorsByProvider[error.provider] ?? 0) + 1;
    }

    // Latency calculations (successes only, errors may have partial latency)
    const latencies = recentSuccesses.map((s) => s.latencyMs).toSorted((a, b) => a - b);
    const averageLatencyMs =
      latencies.length > 0 ? latencies.reduce((a, b) => a + b, 0) / latencies.length : 0;
    const p95LatencyMs = this.calculatePercentile(latencies, 0.95);
    const p99LatencyMs = this.calculatePercentile(latencies, 0.99);

    return {
      totalRequests,
      totalErrors,
      errorRate,
      errorsByCategory,
      errorsByProvider,
      averageLatencyMs,
      p95LatencyMs,
      p99LatencyMs,
      consecutiveErrors: this.consecutiveErrors,
      timeWindowMs: this.config.timeWindowMs,
    };
  }

  /**
   * Get recent errors
   */
  getRecentErrors(limit: number = 100): TrackedError[] {
    this.cleanup();
    return this.errors.slice(-limit).toReversed();
  }

  /**
   * Get errors by category
   */
  getErrorsByCategory(category: ErrorCategory): TrackedError[] {
    this.cleanup();
    return this.errors.filter((e) => e.category === category);
  }

  /**
   * Check if error rate exceeds threshold
   */
  isErrorRateHigh(): boolean {
    const metrics = this.getMetrics();
    return metrics.errorRate > this.config.errorRateThreshold;
  }

  /**
   * Check if consecutive errors exceed threshold
   */
  isConsecutiveErrorsHigh(): boolean {
    return this.consecutiveErrors >= this.config.consecutiveErrorThreshold;
  }

  /**
   * Reset all tracking data
   */
  reset(): void {
    this.errors = [];
    this.successes = [];
    this.consecutiveErrors = 0;
    this.lastSuccessTime = null;
    this.emit("reset");
  }

  /**
   * Get health status summary
   */
  getHealthStatus(): {
    healthy: boolean;
    status: "healthy" | "degraded" | "unhealthy";
    reason?: string;
  } {
    const metrics = this.getMetrics();

    if (metrics.errorRate >= 0.2 || this.consecutiveErrors >= 10) {
      return {
        healthy: false,
        status: "unhealthy",
        reason: `High error rate: ${(metrics.errorRate * 100).toFixed(1)}%, consecutive errors: ${this.consecutiveErrors}`,
      };
    }

    if (metrics.errorRate >= 0.1 || this.consecutiveErrors >= 5) {
      return {
        healthy: false,
        status: "degraded",
        reason: `Elevated error rate: ${(metrics.errorRate * 100).toFixed(1)}%`,
      };
    }

    return { healthy: true, status: "healthy" };
  }

  private categorizeError(error: Error): ErrorCategory {
    const message = error.message.toLowerCase();

    if (message.includes("timeout") || message.includes("etimedout")) {
      return "timeout";
    }

    if (
      message.includes("rate limit") ||
      message.includes("429") ||
      message.includes("too many requests")
    ) {
      return "rate_limit";
    }

    if (
      message.includes("auth") ||
      message.includes("unauthorized") ||
      message.includes("401") ||
      message.includes("403")
    ) {
      return "auth";
    }

    if (
      message.includes("validation") ||
      message.includes("invalid") ||
      message.includes("schema")
    ) {
      return "validation";
    }

    if (
      message.includes("content policy") ||
      message.includes("safety") ||
      message.includes("moderation")
    ) {
      return "content_policy";
    }

    if (
      message.includes("500") ||
      message.includes("502") ||
      message.includes("503") ||
      message.includes("server error")
    ) {
      return "server_error";
    }

    if (
      message.includes("network") ||
      message.includes("econnrefused") ||
      message.includes("enotfound")
    ) {
      return "network";
    }

    return "unknown";
  }

  private checkThresholds(error: TrackedError): void {
    const metrics = this.getMetrics();

    // Error rate threshold
    if (metrics.errorRate > this.config.errorRateThreshold) {
      this.emit("errorRateAlert", {
        errorRate: metrics.errorRate,
        threshold: this.config.errorRateThreshold,
        windowMs: this.config.timeWindowMs,
      });
    }

    // Consecutive errors threshold
    if (this.consecutiveErrors >= this.config.consecutiveErrorThreshold) {
      this.emit("consecutiveErrorAlert", {
        consecutiveErrors: this.consecutiveErrors,
        threshold: this.config.consecutiveErrorThreshold,
      });
    }

    // Category-specific alerts
    if (error.category === "rate_limit") {
      this.emit("rateLimitAlert", { provider: error.provider, model: error.model });
    }

    if (error.category === "auth") {
      this.emit("authAlert", { provider: error.provider });
    }
  }

  private cleanup(): void {
    const now = Date.now();
    const windowStart = now - this.config.timeWindowMs;

    // Remove old errors
    this.errors = this.errors.filter((e) => e.timestamp >= windowStart);

    // Remove old successes
    this.successes = this.successes.filter((s) => s.timestamp >= windowStart);

    // Trim to max size
    if (this.errors.length > this.config.maxStoredErrors) {
      this.errors = this.errors.slice(-this.config.maxStoredErrors);
    }
  }

  private calculatePercentile(sortedValues: number[], percentile: number): number {
    if (sortedValues.length === 0) {
      return 0;
    }
    const index = Math.ceil(sortedValues.length * percentile) - 1;
    return sortedValues[Math.max(0, index)];
  }

  private generateId(): string {
    return `err-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
  }
}

// ============================================================================
// Global Instance
// ============================================================================

let globalTracker: ErrorTracker | null = null;

export function getGlobalErrorTracker(): ErrorTracker {
  if (!globalTracker) {
    globalTracker = new ErrorTracker();
  }
  return globalTracker;
}

export function setGlobalErrorTracker(tracker: ErrorTracker): void {
  globalTracker = tracker;
}
