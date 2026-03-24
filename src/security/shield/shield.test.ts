// ─────────────────────────────────────────────
//  OpenClaw Shield — Test Suite
//  By Kairos Lab
// ─────────────────────────────────────────────

import { describe, it, expect, beforeEach } from "vitest";
import {
  // Circuit Breaker
  createDefaultCircuit,
  checkCircuit,
  recordSuccess,
  recordFailure,
  CIRCUIT_CONFIG,

  // Session Monitor
  detectAuthFlood,
  detectBruteForce,
  detectImpossibleTravel,
  detectDeviceSpray,
  evaluateSession,
  type SessionEvent,

  // Geo Distance
  haversineDistance,
  estimateSpeed,
  isImpossibleTravel,

  // Function Health
  calculateFunctionHealth,
  getFunctionStatus,
  calculatePercentile,
  type FunctionMetrics,

  // Throttle
  makeThrottleDecision,
  getThrottleConfig,

  // Escalation
  evaluateEscalation,
  isGatewayCritical,

  // Metrics
  aggregateByFunctionAndMinute,
  calculateErrorRate,
  type RequestMetric,

  // Webhook
  signWebhookPayload,
  verifyWebhookSignature,
  shouldRetry,

  // Gateway Shield
  GatewayShield,
} from "./index.js";
import {
  validateOrigin,
  validatePayloadSize,
  createConnectionRateTracker,
  generateDeviceFingerprint,
} from "./ws-validation.js";

// ─── Helpers ─────────────────────────────────

function makeEvent(overrides: Partial<SessionEvent> = {}): SessionEvent {
  return {
    user_id: "user-1",
    event_type: "LOGIN",
    ip_address: "1.2.3.4",
    geo_lat: null,
    geo_lon: null,
    geo_country: null,
    device_fingerprint: "abc123",
    success: true,
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

function makeMetrics(overrides: Partial<FunctionMetrics> = {}): FunctionMetrics {
  return {
    functionName: "test-fn",
    window: "1min",
    totalInvocations: 100,
    successCount: 95,
    clientErrorCount: 3,
    serverErrorCount: 2,
    timeoutCount: 0,
    p50Latency: 50,
    p95Latency: 200,
    p99Latency: 500,
    errorRate: 2,
    availability: 95,
    ...overrides,
  };
}

// ═══════════════════════════════════════════════
//  Circuit Breaker Tests
// ═══════════════════════════════════════════════

describe("Circuit Breaker", () => {
  it("starts in CLOSED state", () => {
    const circuit = createDefaultCircuit("test");
    expect(circuit.state).toBe("CLOSED");
    expect(circuit.failureCount).toBe(0);
  });

  it("allows requests when CLOSED", () => {
    const circuit = createDefaultCircuit("test");
    const result = checkCircuit(circuit, Date.now());
    expect(result.allowed).toBe(true);
    expect(result.state).toBe("CLOSED");
  });

  it("opens after reaching failure threshold", () => {
    let circuit = createDefaultCircuit("test");
    const now = Date.now();

    for (let i = 0; i < CIRCUIT_CONFIG.FAILURE_THRESHOLD; i++) {
      const result = recordFailure(circuit, now);
      circuit = result.circuit;
    }

    expect(circuit.state).toBe("OPEN");
    expect(circuit.failureCount).toBe(CIRCUIT_CONFIG.FAILURE_THRESHOLD);
  });

  it("blocks requests when OPEN", () => {
    let circuit = createDefaultCircuit("test");
    const now = Date.now();

    for (let i = 0; i < CIRCUIT_CONFIG.FAILURE_THRESHOLD; i++) {
      circuit = recordFailure(circuit, now).circuit;
    }

    const result = checkCircuit(circuit, now + 1000);
    expect(result.allowed).toBe(false);
    expect(result.state).toBe("OPEN");
    expect(result.retryAfter).toBeGreaterThan(0);
  });

  it("transitions to HALF_OPEN after cooldown", () => {
    let circuit = createDefaultCircuit("test");
    const now = Date.now();

    for (let i = 0; i < CIRCUIT_CONFIG.FAILURE_THRESHOLD; i++) {
      circuit = recordFailure(circuit, now).circuit;
    }

    const afterCooldown = now + CIRCUIT_CONFIG.COOLDOWN_SECONDS * 1000 + 1;
    const result = checkCircuit(circuit, afterCooldown);
    expect(result.allowed).toBe(true);
    expect(result.state).toBe("HALF_OPEN");
  });

  it("resets failure count on success in CLOSED", () => {
    let circuit = createDefaultCircuit("test");
    circuit = recordFailure(circuit, Date.now()).circuit;
    expect(circuit.failureCount).toBe(1);

    circuit = recordSuccess(circuit).circuit;
    expect(circuit.failureCount).toBe(0);
  });
});

// ═══════════════════════════════════════════════
//  Session Monitor Tests
// ═══════════════════════════════════════════════

describe("Session Monitor", () => {
  it("detects auth flood when threshold exceeded", () => {
    const now = new Date();
    const events: SessionEvent[] = Array.from({ length: 25 }, (_, i) =>
      makeEvent({ created_at: new Date(now.getTime() - i * 1000).toISOString() }),
    );

    const result = detectAuthFlood(events, 5, now);
    expect(result.triggered).toBe(true);
    expect(result.rule).toBe("AUTH_FLOOD");
  });

  it("does not trigger auth flood under threshold", () => {
    const now = new Date();
    const events: SessionEvent[] = Array.from({ length: 10 }, (_, i) =>
      makeEvent({ created_at: new Date(now.getTime() - i * 1000).toISOString() }),
    );

    const result = detectAuthFlood(events, 5, now);
    expect(result.triggered).toBe(false);
  });

  it("detects brute force attacks", () => {
    const now = new Date();
    const events: SessionEvent[] = Array.from({ length: 8 }, (_, i) =>
      makeEvent({
        success: false,
        created_at: new Date(now.getTime() - i * 60_000).toISOString(),
      }),
    );

    const result = detectBruteForce(events, 10, now);
    expect(result.triggered).toBe(true);
    expect(result.rule).toBe("BRUTE_FORCE");
  });

  it("detects impossible travel", () => {
    const events: SessionEvent[] = [
      makeEvent({
        geo_lat: 48.8566,
        geo_lon: 2.3522, // Paris
        created_at: new Date(Date.now() - 60_000).toISOString(),
      }),
      makeEvent({
        geo_lat: 35.6762,
        geo_lon: 139.6503, // Tokyo
        created_at: new Date().toISOString(),
      }),
    ];

    const result = detectImpossibleTravel(events);
    expect(result.triggered).toBe(true);
    expect(result.rule).toBe("IMPOSSIBLE_TRAVEL");
  });

  it("does not flag normal travel", () => {
    const events: SessionEvent[] = [
      makeEvent({
        geo_lat: 48.8566,
        geo_lon: 2.3522,
        created_at: new Date(Date.now() - 24 * 3600_000).toISOString(),
      }),
      makeEvent({
        geo_lat: 35.6762,
        geo_lon: 139.6503,
        created_at: new Date().toISOString(),
      }),
    ];

    const result = detectImpossibleTravel(events);
    expect(result.triggered).toBe(false);
  });

  it("detects device spray", () => {
    const now = new Date();
    const events: SessionEvent[] = Array.from({ length: 8 }, (_, i) =>
      makeEvent({
        device_fingerprint: `device-${i}`,
        created_at: new Date(now.getTime() - i * 60_000).toISOString(),
      }),
    );

    const result = detectDeviceSpray(events, 60, now);
    expect(result.triggered).toBe(true);
  });

  it("runs all rules via evaluateSession", () => {
    const now = new Date();
    const events: SessionEvent[] = Array.from({ length: 25 }, (_, i) =>
      makeEvent({ created_at: new Date(now.getTime() - i * 1000).toISOString() }),
    );

    const anomalies = evaluateSession(events, undefined, now);
    expect(anomalies.length).toBeGreaterThan(0);
    expect(anomalies.some((a) => a.rule === "AUTH_FLOOD")).toBe(true);
  });
});

// ═══════════════════════════════════════════════
//  Geo Distance Tests
// ═══════════════════════════════════════════════

describe("Geo Distance", () => {
  it("calculates distance between known cities", () => {
    // Paris to London ≈ 344 km
    const distance = haversineDistance(48.8566, 2.3522, 51.5074, -0.1278);
    expect(distance).toBeGreaterThan(330);
    expect(distance).toBeLessThan(360);
  });

  it("returns 0 for same point", () => {
    const distance = haversineDistance(0, 0, 0, 0);
    expect(distance).toBe(0);
  });

  it("estimates speed correctly", () => {
    const speed = estimateSpeed(100, 3600); // 100km in 1h
    expect(speed).toBe(100);
  });

  it("returns Infinity for zero time", () => {
    expect(estimateSpeed(100, 0)).toBe(Infinity);
  });

  it("detects impossible travel between distant points", () => {
    const loc1 = { lat: 48.8566, lon: 2.3522, timestamp: 0 };
    const loc2 = { lat: 35.6762, lon: 139.6503, timestamp: 60 }; // 1 min later
    expect(isImpossibleTravel(loc1, loc2)).toBe(true);
  });
});

// ═══════════════════════════════════════════════
//  Function Health Tests
// ═══════════════════════════════════════════════

describe("Function Health", () => {
  it("returns 100 for healthy metrics", () => {
    const metrics = makeMetrics({ errorRate: 0, timeoutCount: 0, p95Latency: 100 });
    const score = calculateFunctionHealth(metrics, 200, 100);
    expect(score).toBe(100);
  });

  it("penalizes high error rate", () => {
    const metrics = makeMetrics({ errorRate: 25 });
    const score = calculateFunctionHealth(metrics, 200, 100);
    expect(score).toBeLessThan(50);
  });

  it("penalizes high latency vs baseline", () => {
    const metrics = makeMetrics({ p95Latency: 2000, errorRate: 0 });
    const score = calculateFunctionHealth(metrics, 200, 100);
    expect(score).toBeLessThan(100);
  });

  it("classifies statuses correctly", () => {
    expect(getFunctionStatus(90)).toBe("HEALTHY");
    expect(getFunctionStatus(65)).toBe("DEGRADED");
    expect(getFunctionStatus(30)).toBe("CRITICAL");
    expect(getFunctionStatus(10)).toBe("CIRCUIT_OPEN");
  });

  it("calculates percentiles", () => {
    const values = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    expect(calculatePercentile(values, 50)).toBe(55);
    expect(calculatePercentile(values, 95)).toBeGreaterThan(90);
    expect(calculatePercentile([], 50)).toBe(0);
  });
});

// ═══════════════════════════════════════════════
//  Throttle Tests
// ═══════════════════════════════════════════════

describe("Function Throttle", () => {
  it("allows all traffic for HEALTHY functions", () => {
    const health = {
      functionName: "test",
      healthScore: 90,
      status: "HEALTHY" as const,
      lastChecked: "",
    };
    const config = getThrottleConfig(health);
    expect(config.capacityPercent).toBe(100);
  });

  it("reduces capacity for DEGRADED functions", () => {
    const health = {
      functionName: "test",
      healthScore: 60,
      status: "DEGRADED" as const,
      lastChecked: "",
    };
    const config = getThrottleConfig(health);
    expect(config.capacityPercent).toBeGreaterThan(50);
    expect(config.capacityPercent).toBeLessThan(100);
    expect(config.queueEnabled).toBe(true);
  });

  it("blocks all traffic for CIRCUIT_OPEN", () => {
    const health = {
      functionName: "test",
      healthScore: 5,
      status: "CIRCUIT_OPEN" as const,
      lastChecked: "",
    };
    const decision = makeThrottleDecision(health, 100, 50);
    expect(decision.allowed).toBe(false);
  });
});

// ═══════════════════════════════════════════════
//  Emergency Escalation Tests
// ═══════════════════════════════════════════════

describe("Emergency Escalation", () => {
  it("returns NONE when no circuits are open", () => {
    const result = evaluateEscalation([]);
    expect(result.action).toBe("NONE");
  });

  it("returns ALERT for single non-pipeline critical function", () => {
    // message-handler is gateway-critical but NOT in the pipeline-down rule
    // (only ws-connection and auth-handler trigger GATEWAY_PIPELINE_DOWN)
    const result = evaluateEscalation(["message-handler"]);
    expect(result.action).toBe("ALERT");
    expect(result.ruleId).toBe("SINGLE_CRITICAL");
  });

  it("returns PARTIAL_PAUSE for ws-connection down", () => {
    const result = evaluateEscalation(["ws-connection"]);
    expect(result.action).toBe("PARTIAL_PAUSE");
    expect(result.ruleId).toBe("GATEWAY_PIPELINE_DOWN");
  });

  it("returns PARTIAL_PAUSE for auth-handler down", () => {
    const result = evaluateEscalation(["auth-handler"]);
    expect(result.action).toBe("PARTIAL_PAUSE");
    expect(result.ruleId).toBe("GATEWAY_PIPELINE_DOWN");
  });

  it("returns PARTIAL_PAUSE for 3+ open circuits", () => {
    const result = evaluateEscalation(["fn-1", "fn-2", "fn-3"]);
    expect(result.action).toBe("PARTIAL_PAUSE");
  });

  it("returns FULL_PAUSE for 10+ open circuits", () => {
    const circuits = Array.from({ length: 10 }, (_, i) => `fn-${i}`);
    const result = evaluateEscalation(circuits);
    expect(result.action).toBe("FULL_PAUSE");
  });

  it("identifies gateway-critical functions", () => {
    expect(isGatewayCritical("ws-connection")).toBe(true);
    expect(isGatewayCritical("auth-handler")).toBe(true);
    expect(isGatewayCritical("random-fn")).toBe(false);
  });
});

// ═══════════════════════════════════════════════
//  Metrics Collector Tests
// ═══════════════════════════════════════════════

describe("Metrics Collector", () => {
  it("aggregates metrics by function and minute", () => {
    const now = Date.now();
    const metrics: RequestMetric[] = [
      {
        functionName: "fn-a",
        startTime: now,
        endTime: now + 100,
        status: 200,
        error: false,
        timeout: false,
      },
      {
        functionName: "fn-a",
        startTime: now,
        endTime: now + 200,
        status: 500,
        error: true,
        timeout: false,
      },
      {
        functionName: "fn-b",
        startTime: now,
        endTime: now + 50,
        status: 200,
        error: false,
        timeout: false,
      },
    ];

    const result = aggregateByFunctionAndMinute(metrics);
    const fnAKey = [...result.keys()].find((k) => k.startsWith("fn-a"));
    expect(fnAKey).toBeDefined();

    const fnA = result.get(fnAKey!);
    expect(fnA?.total).toBe(2);
    expect(fnA?.success).toBe(1);
    expect(fnA?.serverErrors).toBe(1);
  });

  it("calculates error rate correctly", () => {
    expect(calculateErrorRate(5, 3, 100)).toBe(8);
    expect(calculateErrorRate(0, 0, 100)).toBe(0);
    expect(calculateErrorRate(0, 0, 0)).toBe(0);
  });
});

// ═══════════════════════════════════════════════
//  Webhook Tests
// ═══════════════════════════════════════════════

describe("Webhook Dispatch", () => {
  it("signs and verifies payloads", () => {
    const payload = '{"test":true}';
    const secret = "test-secret-key";
    const signature = signWebhookPayload(payload, secret);

    expect(verifyWebhookSignature(payload, signature, secret)).toBe(true);
    expect(verifyWebhookSignature(payload, "bad-sig", secret)).toBe(false);
  });

  it("determines retry eligibility", () => {
    expect(shouldRetry(500)).toBe(true);
    expect(shouldRetry(503)).toBe(true);
    expect(shouldRetry(null)).toBe(true);
    expect(shouldRetry(400)).toBe(false);
    expect(shouldRetry(404)).toBe(false);
    expect(shouldRetry(200)).toBe(false);
  });
});

// ═══════════════════════════════════════════════
//  WebSocket Validation Tests
// ═══════════════════════════════════════════════

describe("WebSocket Validation", () => {
  it("accepts missing origin by default", () => {
    expect(validateOrigin(undefined).valid).toBe(true);
  });

  it("rejects missing origin when configured", () => {
    const result = validateOrigin(undefined, {
      ...DEFAULT_WS_VALIDATION_IMPORT,
      allowMissingOrigin: false,
    });
    expect(result.valid).toBe(false);
  });

  it("validates origin against allowlist", () => {
    const config = { ...DEFAULT_WS_VALIDATION_IMPORT, allowedOrigins: ["localhost"] };
    expect(validateOrigin("http://localhost:3000", config).valid).toBe(true);
    expect(validateOrigin("http://evil.com", config).valid).toBe(false);
  });

  it("validates payload size limits", () => {
    expect(validatePayloadSize(100, false).valid).toBe(true);
    expect(validatePayloadSize(100 * 1024, false).valid).toBe(false); // Over 64KB pre-auth
    expect(validatePayloadSize(100 * 1024, true).valid).toBe(true); // OK post-auth
  });

  it("tracks connection rate limits", () => {
    const tracker = createConnectionRateTracker(5);
    for (let i = 0; i < 5; i++) {
      expect(tracker.check().valid).toBe(true);
    }
    expect(tracker.check().valid).toBe(false);
  });

  it("generates device fingerprints", () => {
    const fp = generateDeviceFingerprint("Mozilla/5.0 Test Agent");
    expect(fp).toHaveLength(16);
    expect(generateDeviceFingerprint(undefined)).toBe("unknown");
  });
});

// Import for test config
import { DEFAULT_WS_VALIDATION as DEFAULT_WS_VALIDATION_IMPORT } from "./ws-validation.js";

// ═══════════════════════════════════════════════
//  Gateway Shield Integration Tests
// ═══════════════════════════════════════════════

describe("GatewayShield", () => {
  let shield: GatewayShield;

  beforeEach(() => {
    shield = new GatewayShield();
  });

  it("starts with clean state", () => {
    const summary = shield.getSummary();
    expect(summary.totalEventsProcessed).toBe(0);
    expect((summary.circuitBreakers as { total: number }).total).toBe(0);
  });

  it("creates circuits on first check", () => {
    const result = shield.checkCircuit("ws-handler");
    expect(result.allowed).toBe(true);
  });

  it("opens circuit after repeated failures", () => {
    for (let i = 0; i < CIRCUIT_CONFIG.FAILURE_THRESHOLD; i++) {
      shield.recordFailure("ws-handler");
    }

    const result = shield.checkCircuit("ws-handler");
    expect(result.allowed).toBe(false);
  });

  it("processes auth events and detects anomalies", () => {
    const now = new Date();
    for (let i = 0; i < 25; i++) {
      shield.processAuthEvent(
        makeEvent({ created_at: new Date(now.getTime() - i * 1000).toISOString() }),
      );
    }

    const status = shield.getStatus();
    expect(status.totalEventsProcessed).toBe(25);
    expect(status.recentAnomalies.length).toBeGreaterThan(0);
  });

  it("evaluates escalation when circuits open", () => {
    // Open enough circuits for escalation
    for (let i = 0; i < 3; i++) {
      const name = `fn-${i}`;
      for (let j = 0; j < CIRCUIT_CONFIG.FAILURE_THRESHOLD; j++) {
        shield.recordFailure(name);
      }
    }

    const escalation = shield.evaluateEscalation();
    expect(escalation.action).toBe("PARTIAL_PAUSE");
  });

  it("REOPEN transition resets openedAt and doubles cooldownSeconds", () => {
    // 1. Trip the circuit open
    for (let i = 0; i < CIRCUIT_CONFIG.FAILURE_THRESHOLD; i++) {
      shield.recordFailure("reopen-fn");
    }
    let status = shield.getStatus();
    let circuit = status.circuits.get("reopen-fn")!;
    expect(circuit.state).toBe("OPEN");
    const originalCooldown = circuit.cooldownSeconds;

    // 2. Manually advance openedAt so the next checkCircuit sees HALF_OPEN
    //    (we mutate via the internal map exposed by getStatus snapshot,
    //     so instead we use recordSuccess/recordFailure timing)
    //    Simpler: directly poke the circuit via repeated checkCircuit calls
    //    after enough time.  Use a fresh shield to control timing.
    const timedShield = new GatewayShield();
    for (let i = 0; i < CIRCUIT_CONFIG.FAILURE_THRESHOLD; i++) {
      timedShield.recordFailure("reopen-fn");
    }

    // Get direct access to the circuit via the status snapshot
    // Then re-create with manipulated openedAt
    status = timedShield.getStatus();
    circuit = status.circuits.get("reopen-fn")!;
    expect(circuit.state).toBe("OPEN");

    // Force the circuit into HALF_OPEN by manipulating the internal map:
    // We use the fact that checkCircuit reads from `this.circuits`
    // and the pure checkCircuit transitions OPEN→HALF_OPEN when cooldown expires.
    // So we record enough failing test requests to trigger REOPEN via checkCircuit.

    // Use a third approach: trip open, wait out cooldown (fake via direct circuit manipulation).
    // Since GatewayShield doesn't expose setCircuit, we'll test via the pure functions
    // and verify the GatewayShield path by using the real flow:

    // Create a shield, trip it, then use the integration test approach:
    const s = new GatewayShield();
    for (let i = 0; i < CIRCUIT_CONFIG.FAILURE_THRESHOLD; i++) {
      s.recordFailure("test-reopen");
    }
    status = s.getStatus();
    circuit = status.circuits.get("test-reopen")!;
    expect(circuit.state).toBe("OPEN");
    expect(circuit.cooldownSeconds).toBe(CIRCUIT_CONFIG.COOLDOWN_SECONDS);

    // We can't easily fast-forward time in the integration class,
    // so verify the fix via the pure circuit-breaker functions + gateway-shield behavior:
    // Create a HALF_OPEN circuit that will REOPEN, and call checkCircuit on it.
    let halfOpenCircuit: import("./circuit-breaker.js").CircuitState = {
      functionName: "direct-reopen",
      state: "HALF_OPEN",
      failureCount: CIRCUIT_CONFIG.FAILURE_THRESHOLD,
      lastFailureAt: Date.now(),
      openedAt: Date.now() - 120_000, // opened 2 min ago
      halfOpenAt: Date.now() - 1000,
      cooldownSeconds: CIRCUIT_CONFIG.COOLDOWN_SECONDS,
      testRequestsAllowed: CIRCUIT_CONFIG.HALF_OPEN_TEST_REQUESTS,
      testRequestsProcessed: CIRCUIT_CONFIG.HALF_OPEN_TEST_REQUESTS, // all slots used
      testSuccessCount: 0, // all failed → REOPEN
    };

    // Pure function says REOPEN → state: "OPEN"
    const pureResult = checkCircuit(halfOpenCircuit, Date.now());
    expect(pureResult.state).toBe("OPEN");

    // Now verify that the GatewayShield class properly handles this transition.
    // We inject the half-open circuit into a fresh shield and call checkCircuit.
    const reopenShield = new GatewayShield();
    // Use recordFailure to create the circuit, then manipulate via getStatus internals.
    // Actually, the simplest E2E path: open → simulate cooldown by creating a circuit
    // that's already past cooldown.  We access the private map via a type assertion.
    const shieldAny = reopenShield as unknown as { circuits: Map<string, import("./circuit-breaker.js").CircuitState> };
    shieldAny.circuits.set("direct-reopen", halfOpenCircuit);

    const beforeCheck = Date.now();
    const result = reopenShield.checkCircuit("direct-reopen");
    const afterCheck = Date.now();

    expect(result.allowed).toBe(false);

    // Verify the circuit was properly reopened
    const finalCircuit = reopenShield.getStatus().circuits.get("direct-reopen")!;
    expect(finalCircuit.state).toBe("OPEN");
    // openedAt should be recent (the fix)
    expect(finalCircuit.openedAt).toBeGreaterThanOrEqual(beforeCheck);
    expect(finalCircuit.openedAt).toBeLessThanOrEqual(afterCheck);
    // cooldownSeconds should be doubled (the fix)
    expect(finalCircuit.cooldownSeconds).toBe(
      Math.min(CIRCUIT_CONFIG.COOLDOWN_SECONDS * 2, CIRCUIT_CONFIG.MAX_COOLDOWN_SECONDS),
    );
    // halfOpenAt should be cleared
    expect(finalCircuit.halfOpenAt).toBeNull();
  });

  it("validates WebSocket payloads", () => {
    expect(shield.validateWsPayload(100, false)).toBeNull();
    expect(shield.validateWsPayload(100 * 1024, false)).not.toBeNull();
    expect(shield.validateWsPayload(100 * 1024, true)).toBeNull();
  });

  it("resets cleanly", () => {
    shield.recordFailure("test");
    shield.processAuthEvent(makeEvent());
    shield.reset();

    const summary = shield.getSummary();
    expect(summary.totalEventsProcessed).toBe(0);
    expect((summary.circuitBreakers as { total: number }).total).toBe(0);
  });
});
