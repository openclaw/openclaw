import { describe, it, expect } from "vitest";
import { SignalCollector } from "./signals.js";

describe("SignalCollector", () => {
  it("tracks retry count", () => {
    const collector = new SignalCollector();
    collector.recordRetry();
    collector.recordRetry();
    expect(collector.getSignals().retryCount).toBe(2);
  });

  it("tracks tool call count", () => {
    const collector = new SignalCollector();
    collector.recordToolCall();
    collector.recordToolCall();
    collector.recordToolCall();
    expect(collector.getSignals().toolCallCount).toBe(3);
  });

  it("detects context growth", () => {
    const collector = new SignalCollector();
    collector.recordContextSize(1000);
    collector.recordContextSize(1600); // 60% growth
    const signals = collector.getSignals();
    expect(signals.contextGrowth).toBeCloseTo(0.6, 1);
  });

  it("records error patterns", () => {
    const collector = new SignalCollector();
    collector.recordError("insufficient context");
    const signals = collector.getSignals();
    expect(signals.errors).toContain("insufficient context");
  });
});
