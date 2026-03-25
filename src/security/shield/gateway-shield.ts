// ─────────────────────────────────────────────
//  OpenClaw Shield — Gateway Shield Runtime
//  Centralized security orchestrator integrating
//  circuit breakers, session monitoring, health
//  scoring, and emergency escalation into the
//  OpenClaw gateway lifecycle.
//
//  By Kairos Lab
// ─────────────────────────────────────────────

import {
  type CircuitState,
  CIRCUIT_CONFIG,
  createDefaultCircuit,
  checkCircuit,
  recordSuccess,
  recordFailure,
} from "./circuit-breaker.js";
import { type EscalationResult, evaluateEscalation } from "./emergency-escalation.js";
import {
  type FunctionHealth,
  type FunctionMetrics,
  buildFunctionHealth,
} from "./function-health.js";
import { makeThrottleDecision } from "./function-throttle.js";
import { type RequestMetric, aggregateByFunctionAndMinute } from "./metrics-collector.js";
import { type SessionEvent, type AnomalyResult, evaluateSession } from "./session-monitor.js";

// ─── Types ───────────────────────────────────

export interface ShieldConfig {
  /** Enable circuit breaker protection */
  circuitBreakerEnabled: boolean;
  /** Enable session anomaly detection */
  sessionMonitorEnabled: boolean;
  /** Enable function health scoring */
  healthScoringEnabled: boolean;
  /** Enable emergency escalation */
  escalationEnabled: boolean;
  /** Max WebSocket message payload in bytes */
  maxWsPayloadBytes: number;
  /** Max pre-auth payload in bytes */
  maxPreAuthPayloadBytes: number;
  /** Allowed WebSocket origins (empty = allow all) */
  allowedOrigins: string[];
  /** Webhook URL for security notifications (empty = disabled) */
  webhookUrl: string;
  /** Webhook signing secret */
  webhookSecret: string;
}

export interface ShieldStatus {
  circuits: Map<string, CircuitState>;
  healthScores: Map<string, FunctionHealth>;
  recentAnomalies: AnomalyResult[];
  escalation: EscalationResult | null;
  totalEventsProcessed: number;
  shieldStartedAt: string;
}

// ─── Default Config ──────────────────────────

export const DEFAULT_SHIELD_CONFIG: ShieldConfig = {
  circuitBreakerEnabled: true,
  sessionMonitorEnabled: true,
  healthScoringEnabled: true,
  escalationEnabled: true,
  maxWsPayloadBytes: 10 * 1024 * 1024, // 10 MB
  maxPreAuthPayloadBytes: 64 * 1024, // 64 KB
  allowedOrigins: [],
  webhookUrl: "",
  webhookSecret: "",
};

// ─── Gateway Shield ─────────────────────────

/**
 * GatewayShield is the main runtime orchestrator for OpenClaw's
 * integrated security layer. It manages circuit breakers per
 * gateway function, session event monitoring, health scoring,
 * and emergency escalation — all in-memory, zero external deps.
 */
export class GatewayShield {
  private config: ShieldConfig;
  private circuits: Map<string, CircuitState> = new Map();
  private sessionEvents: SessionEvent[] = [];
  private requestMetrics: RequestMetric[] = [];
  private healthScores: Map<string, FunctionHealth> = new Map();
  /** Rolling baseline: stores last-known p95 latency per function */
  private baselineP95: Map<string, number> = new Map();
  /** Rolling baseline: stores last-known invocations per function */
  private baselineVolume: Map<string, number> = new Map();
  private recentAnomalies: AnomalyResult[] = [];
  private escalation: EscalationResult | null = null;
  private totalEventsProcessed = 0;
  private shieldStartedAt: string;

  /** Session event buffer cap to prevent unbounded growth */
  private static readonly MAX_SESSION_EVENTS = 10_000;
  /** Request metrics buffer cap */
  private static readonly MAX_REQUEST_METRICS = 50_000;
  /** Anomaly history cap */
  private static readonly MAX_ANOMALIES = 100;

  constructor(config?: Partial<ShieldConfig>) {
    this.config = { ...DEFAULT_SHIELD_CONFIG, ...config };
    this.shieldStartedAt = new Date().toISOString();
  }

  // ─── Circuit Breaker ──────────────────────

  /**
   * Check if a request to the named function should be allowed.
   */
  checkCircuit(functionName: string): { allowed: boolean; retryAfter?: number } {
    if (!this.config.circuitBreakerEnabled) {
      return { allowed: true };
    }

    let circuit = this.circuits.get(functionName);
    if (!circuit) {
      circuit = createDefaultCircuit(functionName);
      this.circuits.set(functionName, circuit);
    }

    const result = checkCircuit(circuit, Date.now());

    // Apply state transition if check indicates it
    if (result.state !== circuit.state) {
      if (result.state === "HALF_OPEN") {
        circuit = {
          ...circuit,
          state: "HALF_OPEN",
          halfOpenAt: Date.now(),
          testRequestsProcessed: 0,
          testSuccessCount: 0,
        };
      } else if (result.state === "OPEN" && circuit.state === "HALF_OPEN") {
        // REOPEN — apply exponential backoff exactly like reopenCircuit() does
        circuit = {
          ...circuit,
          state: "OPEN",
          openedAt: Date.now(),
          halfOpenAt: null,
          cooldownSeconds: Math.min(
            circuit.cooldownSeconds * 2,
            CIRCUIT_CONFIG.MAX_COOLDOWN_SECONDS,
          ),
          testRequestsProcessed: 0,
          testSuccessCount: 0,
        };
      } else {
        circuit = { ...circuit, state: result.state };
      }
      this.circuits.set(functionName, circuit);
    }

    return { allowed: result.allowed, retryAfter: result.retryAfter };
  }

  /**
   * Record a successful function invocation.
   */
  recordSuccess(functionName: string): void {
    if (!this.config.circuitBreakerEnabled) {
      return;
    }

    const circuit = this.circuits.get(functionName);
    if (!circuit) {
      return;
    }

    const result = recordSuccess(circuit);
    this.circuits.set(functionName, result.circuit);
  }

  /**
   * Record a failed function invocation.
   */
  recordFailure(functionName: string): void {
    if (!this.config.circuitBreakerEnabled) {
      return;
    }

    let circuit = this.circuits.get(functionName);
    if (!circuit) {
      circuit = createDefaultCircuit(functionName);
      this.circuits.set(functionName, circuit);
    }

    const result = recordFailure(circuit, Date.now());
    this.circuits.set(functionName, result.circuit);

    // Check escalation when a circuit opens
    if (result.stateChanged && result.newState === "OPEN" && this.config.escalationEnabled) {
      this.evaluateEscalation();
    }
  }

  // ─── Session Monitoring ───────────────────

  /**
   * Log and evaluate an auth event for anomalies.
   */
  processAuthEvent(event: SessionEvent): AnomalyResult[] {
    if (!this.config.sessionMonitorEnabled) {
      return [];
    }

    this.totalEventsProcessed++;
    this.sessionEvents.push(event);

    // Cap buffer
    if (this.sessionEvents.length > GatewayShield.MAX_SESSION_EVENTS) {
      this.sessionEvents = this.sessionEvents.slice(-GatewayShield.MAX_SESSION_EVENTS / 2);
    }

    // Run per-user rules
    const userEvents = this.sessionEvents.filter((e) => e.user_id === event.user_id);
    const anomalies = evaluateSession(userEvents, this.sessionEvents);

    if (anomalies.length > 0) {
      this.recentAnomalies.push(...anomalies);
      if (this.recentAnomalies.length > GatewayShield.MAX_ANOMALIES) {
        this.recentAnomalies = this.recentAnomalies.slice(-GatewayShield.MAX_ANOMALIES);
      }
    }

    return anomalies;
  }

  // ─── Health Scoring ────────────────────────

  /**
   * Record a raw request metric for health scoring.
   */
  recordRequestMetric(metric: RequestMetric): void {
    if (!this.config.healthScoringEnabled) {
      return;
    }

    this.requestMetrics.push(metric);

    if (this.requestMetrics.length > GatewayShield.MAX_REQUEST_METRICS) {
      this.requestMetrics = this.requestMetrics.slice(-GatewayShield.MAX_REQUEST_METRICS / 2);
    }
  }

  /**
   * Compute health scores for all tracked functions.
   * Call periodically (e.g., every 60 seconds).
   */
  computeHealthScores(): Map<string, FunctionHealth> {
    if (!this.config.healthScoringEnabled) {
      return this.healthScores;
    }

    // Only use last 5 minutes of metrics
    const fiveMinAgo = Date.now() - 5 * 60 * 1000;
    const recentMetrics = this.requestMetrics.filter((m) => m.startTime >= fiveMinAgo);

    const aggregated = aggregateByFunctionAndMinute(recentMetrics);

    for (const agg of aggregated.values()) {
      const metrics: FunctionMetrics = {
        functionName: agg.functionName,
        window: "1min",
        totalInvocations: agg.total,
        successCount: agg.success,
        clientErrorCount: agg.clientErrors,
        serverErrorCount: agg.serverErrors,
        timeoutCount: agg.timeouts,
        p50Latency: agg.p50,
        p95Latency: agg.p95,
        p99Latency: agg.p99,
        errorRate: agg.errorRate,
        availability: agg.total > 0 ? (agg.success / agg.total) * 100 : 100,
      };

      // Use stored baseline latency/volume from prior cycles.
      // First cycle has no baseline (0) so no latency penalty applies.
      const priorP95 = this.baselineP95.get(agg.functionName) ?? 0;
      const priorVolume = this.baselineVolume.get(agg.functionName) ?? 0;

      const health = buildFunctionHealth(agg.functionName, metrics, priorP95, priorVolume);
      this.healthScores.set(agg.functionName, health);

      // Update rolling baselines for next cycle (exponential moving average)
      const alpha = 0.3; // Weight for new data
      this.baselineP95.set(
        agg.functionName,
        priorP95 > 0 ? priorP95 * (1 - alpha) + agg.p95 * alpha : agg.p95,
      );
      this.baselineVolume.set(
        agg.functionName,
        priorVolume > 0 ? priorVolume * (1 - alpha) + agg.total * alpha : agg.total,
      );
    }

    return this.healthScores;
  }

  /**
   * Check if a request should be throttled based on health.
   */
  shouldThrottle(functionName: string, currentRPM: number, baselineRPM: number): boolean {
    const health = this.healthScores.get(functionName);
    if (!health) {
      return false;
    }

    const decision = makeThrottleDecision(health, currentRPM, baselineRPM);
    return !decision.allowed;
  }

  // ─── Emergency Escalation ──────────────────

  /**
   * Evaluate escalation based on current circuit states.
   */
  evaluateEscalation(): EscalationResult {
    const openCircuits: string[] = [];
    for (const [name, circuit] of this.circuits) {
      if (circuit.state === "OPEN") {
        openCircuits.push(name);
      }
    }

    this.escalation = evaluateEscalation(openCircuits);
    return this.escalation;
  }

  // ─── WebSocket Validation ──────────────────

  /**
   * Validate a WebSocket message payload size.
   * Returns null if valid, error string if rejected.
   */
  validateWsPayload(payloadBytes: number, authenticated: boolean): string | null {
    const limit = authenticated
      ? this.config.maxWsPayloadBytes
      : this.config.maxPreAuthPayloadBytes;

    if (payloadBytes > limit) {
      return `Payload size ${payloadBytes} bytes exceeds limit ${limit} bytes`;
    }
    return null;
  }

  /**
   * Validate WebSocket origin header.
   * Returns true if origin is allowed.
   */
  validateOrigin(origin: string | undefined): boolean {
    if (this.config.allowedOrigins.length === 0) {
      return true;
    }
    if (!origin) {
      return false;
    }
    return this.config.allowedOrigins.includes(origin);
  }

  // ─── Status ────────────────────────────────

  /**
   * Get current shield status snapshot.
   */
  getStatus(): ShieldStatus {
    return {
      circuits: new Map(this.circuits),
      healthScores: new Map(this.healthScores),
      recentAnomalies: [...this.recentAnomalies],
      escalation: this.escalation,
      totalEventsProcessed: this.totalEventsProcessed,
      shieldStartedAt: this.shieldStartedAt,
    };
  }

  /**
   * Get a JSON-serializable status summary for diagnostics.
   */
  getSummary(): Record<string, unknown> {
    const openCircuits: string[] = [];
    const degradedFunctions: string[] = [];

    for (const [name, circuit] of this.circuits) {
      if (circuit.state === "OPEN") {
        openCircuits.push(name);
      }
    }

    for (const [name, health] of this.healthScores) {
      if (health.status !== "HEALTHY") {
        degradedFunctions.push(name);
      }
    }

    return {
      shieldStartedAt: this.shieldStartedAt,
      totalEventsProcessed: this.totalEventsProcessed,
      circuitBreakers: {
        total: this.circuits.size,
        open: openCircuits.length,
        openFunctions: openCircuits,
      },
      healthScores: {
        total: this.healthScores.size,
        degraded: degradedFunctions.length,
        degradedFunctions,
      },
      recentAnomalies: this.recentAnomalies.length,
      escalation: this.escalation
        ? { action: this.escalation.action, ruleId: this.escalation.ruleId }
        : null,
    };
  }

  /**
   * Reset all shield state. Useful for testing.
   */
  reset(): void {
    this.circuits.clear();
    this.sessionEvents = [];
    this.requestMetrics = [];
    this.healthScores.clear();
    this.baselineP95.clear();
    this.baselineVolume.clear();
    this.recentAnomalies = [];
    this.escalation = null;
    this.totalEventsProcessed = 0;
  }
}
