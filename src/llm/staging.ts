import { CircuitBreaker } from "./circuit-breaker.js";
import { ErrorTracker, getGlobalErrorTracker } from "./error-tracker.js";
import { SafetyFilter, standardFilter } from "./safety-filters.js";

/**
 * Staging Configuration — Phase 3: Deployment & Measurement
 *
 * Pre-production configuration for measuring 48-hour error rates
 * before production deployment decision.
 */

export interface StagingConfig {
  /** Environment identifier */
  environment: "staging" | "production";
  /** Measurement window in milliseconds (default: 48 hours) */
  measurementWindowMs: number;
  /** Error rate threshold for LangGraph consideration (default: 5%) */
  errorRateThreshold: number;
  /** Enable circuit breakers */
  enableCircuitBreakers: boolean;
  /** Enable safety filters */
  enableSafetyFilters: boolean;
  /** Enable error tracking */
  enableErrorTracking: boolean;
  /** Enable Helicone observability */
  enableHelicone: boolean;
  /** Log level for staging */
  logLevel: "debug" | "info" | "warn" | "error";
  /** Alert webhook URL for critical issues */
  alertWebhookUrl?: string;
  /** Metrics export interval (ms) */
  metricsExportIntervalMs: number;
}

export const DEFAULT_STAGING_CONFIG: StagingConfig = {
  environment: "staging",
  measurementWindowMs: 48 * 60 * 60 * 1000, // 48 hours
  errorRateThreshold: 0.05, // 5%
  enableCircuitBreakers: true,
  enableSafetyFilters: true,
  enableErrorTracking: true,
  enableHelicone: true,
  logLevel: "info",
  metricsExportIntervalMs: 5 * 60 * 1000, // 5 minutes
};

/**
 * Decision gate result
 */
export interface DecisionGateResult {
  /** Whether the system passed the error rate threshold */
  passed: boolean;
  /** Current error rate (0-1) */
  errorRate: number;
  /** Threshold used for comparison */
  threshold: number;
  /** Measurement period (ms) */
  measurementPeriodMs: number;
  /** Recommendation */
  recommendation: "proceed" | "add_langgraph" | "investigate";
  /** Reasoning for the recommendation */
  reasoning: string;
  /** Metrics at decision time */
  metrics: {
    totalRequests: number;
    totalErrors: number;
    errorsByCategory: Record<string, number>;
    averageLatencyMs: number;
    p95LatencyMs: number;
    p99LatencyMs: number;
  };
}

/**
 * LLM Service wrapper with full guardrails stack
 */
export class StagingLLMService {
  private config: StagingConfig;
  private circuitBreaker: CircuitBreaker;
  private safetyFilter: SafetyFilter;
  private errorTracker: ErrorTracker;
  private startTime: number;

  constructor(config: Partial<StagingConfig> = {}) {
    this.config = { ...DEFAULT_STAGING_CONFIG, ...config };
    this.circuitBreaker = new CircuitBreaker({
      name: "staging-llm",
      failureThreshold: 5,
      failureWindowMs: 60000,
      resetTimeoutMs: 30000,
      successThreshold: 3,
      halfOpenRate: 10,
    });
    this.safetyFilter = standardFilter;
    this.errorTracker = getGlobalErrorTracker();
    this.startTime = Date.now();

    // Start metrics export if configured
    if (this.config.metricsExportIntervalMs > 0) {
      this.startMetricsExport();
    }
  }

  /**
   * Execute LLM call with full guardrails
   */
  async execute<T>(
    operation: () => Promise<T>,
    options: {
      provider: string;
      model: string;
      inputContent?: string;
      timeoutMs?: number;
    },
  ): Promise<T> {
    const startTime = Date.now();

    // Safety filter check on input
    if (this.config.enableSafetyFilters && options.inputContent) {
      const safetyResult = this.safetyFilter.checkOrThrow(options.inputContent);
      if (safetyResult.action === "block") {
        throw new Error(
          `Input blocked by safety filter: ${safetyResult.flags.map((f) => f.type).join(", ")}`,
        );
      }
    }

    try {
      // Execute with circuit breaker
      const result = await this.circuitBreaker.execute(async () => {
        const timeoutMs = options.timeoutMs || 60000;
        return await this.withTimeout(operation(), timeoutMs);
      });

      // Track success
      const latencyMs = Date.now() - startTime;
      this.errorTracker.trackSuccess(options.provider, options.model, latencyMs);

      return result;
    } catch (error) {
      // Track error
      this.errorTracker.trackError(error as Error, options.provider, options.model, {
        latencyMs: Date.now() - startTime,
      });
      throw error;
    }
  }

  /**
   * Evaluate decision gate
   */
  evaluateDecisionGate(): DecisionGateResult {
    const metrics = this.errorTracker.getMetrics();
    const currentTime = Date.now();
    const measurementPeriodMs = Math.min(
      currentTime - this.startTime,
      this.config.measurementWindowMs,
    );

    const passed = metrics.errorRate <= this.config.errorRateThreshold;

    let recommendation: DecisionGateResult["recommendation"];
    let reasoning: string;

    if (passed) {
      recommendation = "proceed";
      reasoning = `Error rate ${(metrics.errorRate * 100).toFixed(2)}% is within threshold ${(this.config.errorRateThreshold * 100).toFixed(2)}%. No LangGraph required.`;
    } else if (metrics.errorRate <= 0.15) {
      recommendation = "add_langgraph";
      reasoning = `Error rate ${(metrics.errorRate * 100).toFixed(2)}% exceeds threshold. Recommend adding LangGraph for deterministic workflow control.`;
    } else {
      recommendation = "investigate";
      reasoning = `Error rate ${(metrics.errorRate * 100).toFixed(2)}% critically high. Investigate root causes before proceeding.`;
    }

    return {
      passed,
      errorRate: metrics.errorRate,
      threshold: this.config.errorRateThreshold,
      measurementPeriodMs,
      recommendation,
      reasoning,
      metrics: {
        totalRequests: metrics.totalRequests,
        totalErrors: metrics.totalErrors,
        errorsByCategory: metrics.errorsByCategory,
        averageLatencyMs: metrics.averageLatencyMs,
        p95LatencyMs: metrics.p95LatencyMs,
        p99LatencyMs: metrics.p99LatencyMs,
      },
    };
  }

  /**
   * Get current health status
   */
  getHealthStatus(): ReturnType<ErrorTracker["getHealthStatus"]> {
    return this.errorTracker.getHealthStatus();
  }

  /**
   * Get current metrics
   */
  getMetrics(): ReturnType<ErrorTracker["getMetrics"]> {
    return this.errorTracker.getMetrics();
  }

  /**
   * Export metrics for external monitoring
   */
  exportMetrics(): Record<string, unknown> {
    const metrics = this.errorTracker.getMetrics();
    const circuitMetrics = this.circuitBreaker.getMetrics();
    const decision = this.evaluateDecisionGate();

    return {
      timestamp: new Date().toISOString(),
      environment: this.config.environment,
      circuitBreaker: circuitMetrics,
      errors: metrics,
      decisionGate: decision,
      uptimeMs: Date.now() - this.startTime,
    };
  }

  /**
   * Reset all tracking data
   */
  reset(): void {
    this.errorTracker.reset();
    this.circuitBreaker.forceClose();
    this.startTime = Date.now();
  }

  private async withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    return Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error(`Operation timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  }

  private startMetricsExport(): void {
    setInterval(() => {
      const metrics = this.exportMetrics();

      // Log metrics
      console.log("[StagingLLMService] Metrics export:", JSON.stringify(metrics, null, 2));

      // Send to webhook if configured
      if (this.config.alertWebhookUrl) {
        this.sendWebhook(metrics).catch(console.error);
      }
    }, this.config.metricsExportIntervalMs);
  }

  private async sendWebhook(metrics: Record<string, unknown>): Promise<void> {
    if (!this.config.alertWebhookUrl) {
      return;
    }

    try {
      const response = await fetch(this.config.alertWebhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(metrics),
      });

      if (!response.ok) {
        console.error(`[StagingLLMService] Webhook failed: ${response.status}`);
      }
    } catch (error) {
      console.error("[StagingLLMService] Webhook error:", error);
    }
  }
}

/**
 * Quick health check for monitoring endpoints
 */
export function healthCheck(service: StagingLLMService): {
  status: "healthy" | "degraded" | "unhealthy";
  checks: Record<string, boolean>;
} {
  const health = service.getHealthStatus();
  const metrics = service.getMetrics();
  const circuitMetrics = service.exportMetrics().circuitBreaker as { state: string };

  const checks = {
    errorRateAcceptable: metrics.errorRate < 0.1,
    noConsecutiveErrors: health.status !== "unhealthy",
    circuitBreakerClosed: circuitMetrics.state === "CLOSED",
    latencyAcceptable: metrics.p95LatencyMs < 10000,
  };

  const allPassed = Object.values(checks).every(Boolean);
  const anyFailed = Object.values(checks).some((c) => !c);

  return {
    status: allPassed ? "healthy" : anyFailed ? "unhealthy" : "degraded",
    checks,
  };
}
