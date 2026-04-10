// Octopus Orchestrator — OctoMetrics tests (M1-24)

import { describe, expect, it, vi } from "vitest";
import {
  type MetricsProvider,
  METRIC_ARMS_ACTIVE,
  METRIC_ARMS_IDLE,
  METRIC_ARM_RESTARTS,
  METRIC_ARM_SPAWN_DURATION,
  METRIC_EVENTS_WRITTEN,
  METRIC_EVENT_LOG_BYTES,
  OctoMetrics,
  noopMetricsProvider,
} from "./metrics.ts";

type GaugeFn = MetricsProvider["gauge"];
type CounterFn = MetricsProvider["counter"];
type HistogramFn = MetricsProvider["histogram"];

interface MockProvider extends MetricsProvider {
  gauge: ReturnType<typeof vi.fn<GaugeFn>>;
  counter: ReturnType<typeof vi.fn<CounterFn>>;
  histogram: ReturnType<typeof vi.fn<HistogramFn>>;
}

function makeMockProvider(): MockProvider {
  return {
    gauge: vi.fn<GaugeFn>(),
    counter: vi.fn<CounterFn>(),
    histogram: vi.fn<HistogramFn>(),
  };
}

describe("OctoMetrics", () => {
  it("recordArmsActive calls gauge with correct metric name", () => {
    const p = makeMockProvider();
    const m = new OctoMetrics(p);
    m.recordArmsActive(5);
    expect(p.gauge).toHaveBeenCalledWith(METRIC_ARMS_ACTIVE, 5);
  });

  it("recordArmsIdle calls gauge with correct metric name", () => {
    const p = makeMockProvider();
    const m = new OctoMetrics(p);
    m.recordArmsIdle(3);
    expect(p.gauge).toHaveBeenCalledWith(METRIC_ARMS_IDLE, 3);
  });

  it("recordArmSpawnDuration calls histogram with correct metric name", () => {
    const p = makeMockProvider();
    const m = new OctoMetrics(p);
    m.recordArmSpawnDuration(1.23);
    expect(p.histogram).toHaveBeenCalledWith(METRIC_ARM_SPAWN_DURATION, 1.23);
  });

  it("recordArmRestart calls counter with increment 1", () => {
    const p = makeMockProvider();
    const m = new OctoMetrics(p);
    m.recordArmRestart();
    expect(p.counter).toHaveBeenCalledWith(METRIC_ARM_RESTARTS, 1);
  });

  it("recordEventWritten calls counter with increment 1", () => {
    const p = makeMockProvider();
    const m = new OctoMetrics(p);
    m.recordEventWritten();
    expect(p.counter).toHaveBeenCalledWith(METRIC_EVENTS_WRITTEN, 1);
  });

  it("recordEventLogBytes calls gauge with correct metric name", () => {
    const p = makeMockProvider();
    const m = new OctoMetrics(p);
    m.recordEventLogBytes(4096);
    expect(p.gauge).toHaveBeenCalledWith(METRIC_EVENT_LOG_BYTES, 4096);
  });

  it("multiple calls accumulate on the provider", () => {
    const p = makeMockProvider();
    const m = new OctoMetrics(p);
    m.recordArmRestart();
    m.recordArmRestart();
    m.recordArmRestart();
    expect(p.counter).toHaveBeenCalledTimes(3);
  });

  it("noopMetricsProvider does not throw on any method", () => {
    const m = new OctoMetrics(noopMetricsProvider);
    expect(() => {
      m.recordArmsActive(0);
      m.recordArmsIdle(0);
      m.recordArmSpawnDuration(0);
      m.recordArmRestart();
      m.recordEventWritten();
      m.recordEventLogBytes(0);
    }).not.toThrow();
  });

  it("metric name constants have the openclaw_octo_ prefix", () => {
    for (const name of [
      METRIC_ARMS_ACTIVE,
      METRIC_ARMS_IDLE,
      METRIC_ARM_SPAWN_DURATION,
      METRIC_ARM_RESTARTS,
      METRIC_EVENTS_WRITTEN,
      METRIC_EVENT_LOG_BYTES,
    ]) {
      expect(name).toMatch(/^openclaw_octo_/);
    }
  });
});
