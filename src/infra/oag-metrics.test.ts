import { describe, expect, it, beforeEach } from "vitest";
import {
  incrementOagMetric,
  getOagMetrics,
  getOagMetricsEntries,
  resetOagMetrics,
  snapshotMetrics,
  restoreMetricsFromLastSnapshot,
} from "./oag-metrics.js";

describe("oag-metrics", () => {
  beforeEach(() => {
    resetOagMetrics();
  });

  it("starts with all counters at zero", () => {
    const metrics = getOagMetrics();
    expect(metrics.channelRestarts).toBe(0);
    expect(metrics.deliveryRecoveries).toBe(0);
    expect(metrics.noteDeliveries).toBe(0);
  });

  it("increments a counter by 1 by default", () => {
    incrementOagMetric("channelRestarts");
    incrementOagMetric("channelRestarts");
    expect(getOagMetrics().channelRestarts).toBe(2);
  });

  it("increments a counter by a custom amount", () => {
    incrementOagMetric("deliveryRecoveries", 5);
    expect(getOagMetrics().deliveryRecoveries).toBe(5);
  });

  it("returns a snapshot copy, not a reference", () => {
    incrementOagMetric("noteDeliveries");
    const snapshot = getOagMetrics();
    incrementOagMetric("noteDeliveries");
    expect(snapshot.noteDeliveries).toBe(1);
    expect(getOagMetrics().noteDeliveries).toBe(2);
  });

  it("formats entries with snake_case metric names", () => {
    incrementOagMetric("channelRestarts", 3);
    incrementOagMetric("stalePollDetections", 1);
    const entries = getOagMetricsEntries();
    const restart = entries.find((e) => e.name === "oag_channel_restarts");
    expect(restart).toBeDefined();
    expect(restart?.value).toBe(3);
    const poll = entries.find((e) => e.name === "oag_stale_poll_detections");
    expect(poll).toBeDefined();
    expect(poll?.value).toBe(1);
  });

  it("resets all counters to zero", () => {
    incrementOagMetric("channelRestarts", 10);
    incrementOagMetric("noteDeliveries", 5);
    resetOagMetrics();
    const metrics = getOagMetrics();
    expect(metrics.channelRestarts).toBe(0);
    expect(metrics.noteDeliveries).toBe(0);
  });

  it("snapshotMetrics captures current counters with timestamp and uptime", () => {
    incrementOagMetric("channelRestarts", 3);
    incrementOagMetric("noteDeliveries", 7);
    const snap = snapshotMetrics(5000);
    expect(snap.uptimeMs).toBe(5000);
    expect(snap.timestamp).toBeDefined();
    expect(snap.metrics.channelRestarts).toBe(3);
    expect(snap.metrics.noteDeliveries).toBe(7);
    expect(snap.metrics.deliveryRecoveries).toBe(0);
  });

  it("snapshotMetrics returns a copy, not a reference to internal counters", () => {
    incrementOagMetric("channelRestarts", 1);
    const snap = snapshotMetrics(1000);
    incrementOagMetric("channelRestarts", 10);
    expect(snap.metrics.channelRestarts).toBe(1);
    expect(getOagMetrics().channelRestarts).toBe(11);
  });

  it("restoreMetricsFromLastSnapshot restores saved counters", () => {
    const saved = {
      metrics: {
        channelRestarts: 42,
        noteDeliveries: 100,
        deliveryRecoveries: 5,
      },
    };
    restoreMetricsFromLastSnapshot(saved);
    const metrics = getOagMetrics();
    expect(metrics.channelRestarts).toBe(42);
    expect(metrics.noteDeliveries).toBe(100);
    expect(metrics.deliveryRecoveries).toBe(5);
    // Counters not in snapshot stay at 0
    expect(metrics.stalePollDetections).toBe(0);
  });

  it("restoreMetricsFromLastSnapshot ignores unknown keys", () => {
    const saved = {
      metrics: {
        channelRestarts: 10,
        unknownFutureMetric: 999,
      },
    };
    restoreMetricsFromLastSnapshot(saved);
    const metrics = getOagMetrics();
    expect(metrics.channelRestarts).toBe(10);
    // Unknown key should not appear
    expect((metrics as Record<string, unknown>).unknownFutureMetric).toBeUndefined();
  });

  it("restoreMetricsFromLastSnapshot skips zero or negative values", () => {
    incrementOagMetric("channelRestarts", 5);
    const saved = {
      metrics: {
        channelRestarts: 0,
        noteDeliveries: -1,
      },
    };
    restoreMetricsFromLastSnapshot(saved);
    const metrics = getOagMetrics();
    // channelRestarts should keep its existing value since saved is 0
    expect(metrics.channelRestarts).toBe(5);
    expect(metrics.noteDeliveries).toBe(0);
  });
});
