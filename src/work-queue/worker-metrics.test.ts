import { describe, expect, it } from "vitest";
import { WorkerMetrics } from "./worker-metrics.js";

describe("WorkerMetrics", () => {
  it("starts with zero counters", () => {
    const metrics = new WorkerMetrics();
    const snap = metrics.snapshot("agent-1", null);

    expect(snap.agentId).toBe("agent-1");
    expect(snap.totalProcessed).toBe(0);
    expect(snap.totalSucceeded).toBe(0);
    expect(snap.totalFailed).toBe(0);
    expect(snap.averageProcessingTimeMs).toBe(0);
    expect(snap.lastProcessingTimeMs).toBeUndefined();
    expect(snap.currentItemId).toBeNull();
    expect(snap.consecutiveErrors).toBe(0);
  });

  it("accumulates successful processing", () => {
    const metrics = new WorkerMetrics();

    metrics.recordProcessing(100, true);
    metrics.recordProcessing(200, true);

    const snap = metrics.snapshot("agent-1", null);
    expect(snap.totalProcessed).toBe(2);
    expect(snap.totalSucceeded).toBe(2);
    expect(snap.totalFailed).toBe(0);
    expect(snap.averageProcessingTimeMs).toBe(150);
    expect(snap.lastProcessingTimeMs).toBe(200);
  });

  it("accumulates failed processing", () => {
    const metrics = new WorkerMetrics();

    metrics.recordProcessing(50, false);
    metrics.recordProcessing(150, true);

    const snap = metrics.snapshot("agent-1", null);
    expect(snap.totalProcessed).toBe(2);
    expect(snap.totalSucceeded).toBe(1);
    expect(snap.totalFailed).toBe(1);
    expect(snap.averageProcessingTimeMs).toBe(100);
  });

  it("tracks consecutive errors", () => {
    const metrics = new WorkerMetrics();

    metrics.recordProcessing(100, false);
    metrics.recordProcessing(100, false);
    expect(metrics.snapshot("a", null).consecutiveErrors).toBe(2);

    metrics.recordProcessing(100, true);
    expect(metrics.snapshot("a", null).consecutiveErrors).toBe(0);
  });

  it("includes currentItemId in snapshot", () => {
    const metrics = new WorkerMetrics();
    const snap = metrics.snapshot("agent-1", "item-42");

    expect(snap.currentItemId).toBe("item-42");
  });

  it("tracks uptime since construction", async () => {
    const metrics = new WorkerMetrics();
    await new Promise((r) => setTimeout(r, 50));

    const snap = metrics.snapshot("agent-1", null);
    expect(snap.uptimeMs).toBeGreaterThanOrEqual(40);
    expect(snap.startedAt).toBeDefined();
  });
});
