import { channel } from "node:diagnostics_channel";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { expect, it } from "vitest";
import { startGatewayBenchDiagnostics } from "../../scripts/lib/gateway-bench-diagnostics.js";

it("aggregates captured work with bounded memory and drops content-bearing fields", () => {
  const source = channel("openclaw.session.write");
  const lists = channel("openclaw.session.list");
  const finish = startGatewayBenchDiagnostics();
  let result;
  try {
    for (let index = 0; index < 2; index += 1) {
      source.publish({
        operation: "session-entry.patch",
        outcome: "ok",
        writer: "foreground",
        queueWaitMs: 20 + index,
        writerExecutionMs: 2,
        storePath: "/private/example",
        agentId: "private-agent",
        error: "private-error",
      });
      lists.publish({
        operation: "sessions.list",
        responseOutcome: "ok",
        cacheRole: "projection-owner",
        storeLoadThreadCpuMs: 0.75 * (index + 1),
        prepareThreadCpuMs: 1.5 * (index + 1),
        rowThreadCpuMs: 2.25 * (index + 1),
        cacheSelectionThreadCpuMs: 0.125 * (index + 1),
        cachePublicationThreadCpuMs: 0.25 * (index + 1),
        responseThreadCpuMs: 0.375 * (index + 1),
      });
    }
    for (let index = 0; index < 300; index += 1) {
      source.publish({ operation: `session.synthetic-${index}`, outcome: "ok", elapsedMs: 1 });
    }
  } finally {
    result = finish();
  }
  expect(result.groups).toHaveLength(256);
  expect(result.droppedEvents).toBe(46);
  expect(result.collectionErrors).toBe(0);
  expect(result.droppedHistogramSamples).toBe(6);
  expect(result.groups[0]).toMatchObject({
    operation: "session-entry.patch",
    count: 2,
    metrics: {
      queueWaitMs: { count: 2, total: 41, max: 21 },
      writerExecutionMs: { count: 2, total: 4, max: 2 },
    },
  });
  expect(result.groups[1]).toMatchObject({
    operation: "sessions.list",
    cacheRole: "projection-owner",
    count: 2,
    metrics: {
      storeLoadThreadCpuMs: { count: 2, total: 2.25, max: 1.5 },
      prepareThreadCpuMs: { count: 2, total: 4.5, max: 3 },
      rowThreadCpuMs: { count: 2, total: 6.75, max: 4.5 },
      cacheSelectionThreadCpuMs: { count: 2, total: 0.375, max: 0.25 },
      cachePublicationThreadCpuMs: { count: 2, total: 0.75, max: 0.5 },
      responseThreadCpuMs: { count: 2, total: 1.125, max: 0.75 },
    },
  });
  expect(JSON.stringify(result)).not.toContain("private");
  source.publish({ operation: "session-entry.patch", outcome: "ok", queueWaitMs: 999 });
  expect(result.groups[0]).toMatchObject({ count: 2 });
});

it("reports latency tails, preserves zero, and bounds outliers without changing raw aggregates", () => {
  const source = channel("openclaw.worker.task");
  const finish = startGatewayBenchDiagnostics();
  let result;
  try {
    for (const runMs of [0, 1, 2, 3, 4, 1_000_000_000]) {
      source.publish({
        worker: "synthetic",
        outcome: "ok",
        runMs,
        queueMs: 0,
        pendingBytes: 12,
        transferMs: Number.NaN,
        preparationMs: -1,
        hostWaitMs: Number.POSITIVE_INFINITY,
      });
    }
  } finally {
    result = finish();
  }
  const metrics = expectDefined(result.groups[0], "worker diagnostic group").metrics;
  expect(metrics.runMs).toMatchObject({
    count: 6,
    total: 1_000_000_010,
    max: 1_000_000_000,
    histogramCount: 6,
    clampedCount: 1,
    p50: expect.closeTo(2, 1),
  });
  expect(metrics.runMs).toHaveProperty("p95", expect.closeTo(3_600_000, -5));
  expect(metrics.runMs).toHaveProperty("p99", expect.closeTo(3_600_000, -5));
  expect(metrics.queueMs).toMatchObject({ p50: 0, p95: 0, p99: 0, clampedCount: 0 });
  expect(metrics.pendingBytes).toEqual({ count: 6, total: 72, max: 12 });
  expect(metrics).not.toHaveProperty("transferMs");
  expect(metrics).not.toHaveProperty("preparationMs");
  expect(metrics).not.toHaveProperty("hostWaitMs");
  expect(result.collectionErrors).toBe(0);
});
