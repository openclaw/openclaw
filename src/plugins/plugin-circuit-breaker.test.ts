import { describe, expect, it } from "vitest";
import {
  advancePluginCircuitBreakerState,
  createPluginCircuitBreakerState,
  normalizePluginCriticality,
  recordPluginCircuitBreakerFailure,
  recordPluginCircuitBreakerSuccess,
  resolvePluginCircuitBreakerConfig,
  resolvePluginCircuitBreakerDecision,
  type PluginCircuitBreakerState,
} from "./plugin-circuit-breaker.js";

describe("plugin circuit breaker", () => {
  it("derives thresholds from criticality metadata without plugin id policy", () => {
    expect(resolvePluginCircuitBreakerConfig({ criticality: "critical" })).toMatchObject({
      failureThreshold: 5,
      cooldownMs: 30_000,
      halfOpenSuccessThreshold: 2,
    });
    expect(resolvePluginCircuitBreakerConfig({ criticality: "experimental" })).toMatchObject({
      failureThreshold: 1,
      cooldownMs: 300_000,
      halfOpenSuccessThreshold: 1,
    });
    expect(normalizePluginCriticality("not-a-level")).toBe("important");
  });

  it("opens after consecutive failures and blocks until cooldown expires", () => {
    const nowMs = 1_000;
    let state = createPluginCircuitBreakerState({
      pluginId: "demo-plugin",
      criticality: "optional",
      nowMs,
    });

    state = recordPluginCircuitBreakerFailure({ state, reason: "timeout", nowMs: nowMs + 10 });
    expect(state.status).toBe("closed");

    state = recordPluginCircuitBreakerFailure({ state, reason: "load_error", nowMs: nowMs + 20 });
    expect(state).toMatchObject({
      pluginId: "demo-plugin",
      criticality: "optional",
      status: "open",
      consecutiveFailures: 2,
      lastFailureReason: "load_error",
      nextProbeAtMs: nowMs + 120_020,
    });

    expect(resolvePluginCircuitBreakerDecision({ state, nowMs: nowMs + 30 })).toMatchObject({
      allowExecution: false,
      probe: false,
      reason: "cooldown_active",
    });
  });

  it("moves from open to half-open after cooldown, then closes after successful probe", () => {
    const nowMs = 5_000;
    const initial = createPluginCircuitBreakerState({
      pluginId: "probe-plugin",
      criticality: "experimental",
      nowMs,
    });
    const open = recordPluginCircuitBreakerFailure({
      state: initial,
      reason: "runtime_error",
      nowMs,
    });
    const halfOpen = advancePluginCircuitBreakerState({
      state: open,
      nowMs: nowMs + 300_000,
    });

    expect(halfOpen.status).toBe("half-open");
    expect(resolvePluginCircuitBreakerDecision({ state: halfOpen })).toMatchObject({
      allowExecution: true,
      probe: true,
      reason: "half_open_probe",
    });

    const closed = recordPluginCircuitBreakerSuccess({
      state: halfOpen,
      nowMs: nowMs + 300_010,
    });

    expect(closed).toMatchObject({
      status: "closed",
      consecutiveFailures: 0,
      consecutiveSuccesses: 0,
      lastSuccessAtMs: nowMs + 300_010,
    });
    expect(closed.nextProbeAtMs).toBeUndefined();
  });

  it("reopens when the half-open probe fails", () => {
    const nowMs = 10_000;
    const open = recordPluginCircuitBreakerFailure({
      state: createPluginCircuitBreakerState({
        pluginId: "recovering-plugin",
        criticality: "experimental",
        nowMs,
      }),
      reason: "health_check_failed",
      nowMs,
    });
    const halfOpen = advancePluginCircuitBreakerState({
      state: open,
      nowMs: nowMs + 300_000,
    });
    const reopened = recordPluginCircuitBreakerFailure({
      state: halfOpen,
      reason: "timeout",
      nowMs: nowMs + 300_010,
    });

    expect(reopened).toMatchObject({
      status: "open",
      consecutiveFailures: 2,
      lastFailureReason: "timeout",
      nextProbeAtMs: nowMs + 600_010,
    });
  });

  it("covers closed, open, and half-open status fixtures", () => {
    const closed = createPluginCircuitBreakerState({
      pluginId: "fixture-plugin",
      criticality: "important",
      nowMs: 1,
    });
    const open = recordPluginCircuitBreakerFailure({
      state: closed,
      reason: "timeout",
      nowMs: 2,
      config: { failureThreshold: 1, cooldownMs: 100 },
    });
    const halfOpen = advancePluginCircuitBreakerState({ state: open, nowMs: 102 });
    const fixture: PluginCircuitBreakerState[] = [closed, open, halfOpen];

    expect(fixture.map((entry) => entry.status)).toEqual(["closed", "open", "half-open"]);
  });
});
