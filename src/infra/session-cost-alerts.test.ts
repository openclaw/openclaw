import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import {
  SessionCostAlertMonitor,
  getDefaultCostAlertMonitor,
  resetDefaultCostAlertMonitor,
} from "./session-cost-alerts.js";

describe("SessionCostAlertMonitor", () => {
  let monitor: SessionCostAlertMonitor;

  beforeEach(() => {
    monitor = new SessionCostAlertMonitor({
      thresholds: [
        { level: "warning", costUsd: 0.5 },
        { level: "critical", costUsd: 2.0 },
      ],
    });
  });

  it("does not fire below threshold", () => {
    const alerts = monitor.check({
      sessionId: "s1",
      currentCostUsd: 0.1,
      currentTokens: 1000,
    });
    expect(alerts).toHaveLength(0);
  });

  it("fires warning at threshold", () => {
    const alerts = monitor.check({
      sessionId: "s1",
      currentCostUsd: 0.5,
      currentTokens: 5000,
    });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.level).toBe("warning");
    expect(alerts[0]?.sessionId).toBe("s1");
  });

  it("fires both thresholds when cost exceeds both", () => {
    const alerts = monitor.check({
      sessionId: "s1",
      currentCostUsd: 3.0,
      currentTokens: 50000,
    });
    expect(alerts).toHaveLength(2);
    expect(alerts[0]?.level).toBe("warning");
    expect(alerts[1]?.level).toBe("critical");
  });

  it("does not re-fire already triggered thresholds", () => {
    monitor.check({ sessionId: "s1", currentCostUsd: 0.6, currentTokens: 5000 });
    const alerts = monitor.check({
      sessionId: "s1",
      currentCostUsd: 0.8,
      currentTokens: 8000,
    });
    expect(alerts).toHaveLength(0);
  });

  it("fires critical after warning was already fired", () => {
    monitor.check({ sessionId: "s1", currentCostUsd: 0.6, currentTokens: 5000 });
    const alerts = monitor.check({
      sessionId: "s1",
      currentCostUsd: 2.5,
      currentTokens: 25000,
    });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.level).toBe("critical");
  });

  it("tracks sessions independently", () => {
    monitor.check({ sessionId: "s1", currentCostUsd: 0.6, currentTokens: 5000 });
    const alerts = monitor.check({
      sessionId: "s2",
      currentCostUsd: 0.7,
      currentTokens: 7000,
    });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.sessionId).toBe("s2");
  });

  it("hasFired returns correct state", () => {
    expect(monitor.hasFired("s1", "warning")).toBe(false);
    monitor.check({ sessionId: "s1", currentCostUsd: 0.6, currentTokens: 5000 });
    expect(monitor.hasFired("s1", "warning")).toBe(true);
    expect(monitor.hasFired("s1", "critical")).toBe(false);
  });

  it("resetSession clears fired state", () => {
    monitor.check({ sessionId: "s1", currentCostUsd: 0.6, currentTokens: 5000 });
    monitor.resetSession("s1");
    expect(monitor.hasFired("s1", "warning")).toBe(false);

    const alerts = monitor.check({
      sessionId: "s1",
      currentCostUsd: 0.6,
      currentTokens: 5000,
    });
    expect(alerts).toHaveLength(1);
  });

  it("calls onAlert callback", () => {
    const callback = vi.fn();
    const m = new SessionCostAlertMonitor({
      thresholds: [{ level: "warning", costUsd: 0.5 }],
      onAlert: callback,
    });

    m.check({ sessionId: "s1", currentCostUsd: 0.6, currentTokens: 5000 });
    expect(callback).toHaveBeenCalledOnce();
    expect(callback.mock.calls[0]?.[0]?.level).toBe("warning");
  });

  it("triggers on token threshold", () => {
    const m = new SessionCostAlertMonitor({
      thresholds: [{ level: "warning", costUsd: 100, tokens: 1000 }],
    });

    const alerts = m.check({
      sessionId: "s1",
      currentCostUsd: 0.01,
      currentTokens: 1500,
    });
    expect(alerts).toHaveLength(1);
  });

  it("does nothing when disabled", () => {
    const m = new SessionCostAlertMonitor({
      enabled: false,
      thresholds: [{ level: "warning", costUsd: 0.01 }],
    });

    const alerts = m.check({
      sessionId: "s1",
      currentCostUsd: 100,
      currentTokens: 999999,
    });
    expect(alerts).toHaveLength(0);
  });

  it("swallows callback errors", () => {
    const m = new SessionCostAlertMonitor({
      thresholds: [{ level: "warning", costUsd: 0.5 }],
      onAlert: () => {
        throw new Error("boom");
      },
    });

    expect(() =>
      m.check({ sessionId: "s1", currentCostUsd: 1.0, currentTokens: 5000 }),
    ).not.toThrow();
  });
});

describe("default monitor singleton", () => {
  afterEach(() => {
    resetDefaultCostAlertMonitor();
  });

  it("returns same instance", () => {
    const a = getDefaultCostAlertMonitor();
    const b = getDefaultCostAlertMonitor();
    expect(a).toBe(b);
  });
});

