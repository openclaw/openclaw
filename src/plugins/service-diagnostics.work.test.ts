import { afterEach, expect, it, vi } from "vitest";
import { hasInternalDiagnosticEventInterest } from "../infra/diagnostic-event-listener-presence.js";
import {
  resetDiagnosticEventsForTest,
  setDiagnosticsEnabledForProcess,
  waitForDiagnosticEventsDrained,
} from "../infra/diagnostic-events.js";
import {
  hasGatewayWorkMetricsListeners,
  publishGatewayWorkMetrics,
} from "../infra/gateway-work-metrics.js";
import { trackWorkerRequest } from "../infra/worker-request-diagnostics.js";
import { createPluginRuntimeCapabilityLease } from "./capability-lease.js";
import { createPluginServiceDiagnostics } from "./service-diagnostics.js";

afterEach(() => {
  publishGatewayWorkMetrics(undefined);
  resetDiagnosticEventsForTest();
  vi.restoreAllMocks();
});

function createExporterDiagnostics() {
  const lease = createPluginRuntimeCapabilityLease("diagnostics-prometheus");
  const diagnostics = createPluginServiceDiagnostics(
    {
      id: "diagnostics-prometheus",
      pluginId: "diagnostics-prometheus",
      origin: "bundled",
      source: "test",
      service: { id: "diagnostics-prometheus", start() {} },
    },
    lease,
  )!;
  return { lease, diagnostics };
}

it("replays owner work and revokes its subscription with the exporter capability", () => {
  const { lease, diagnostics } = createExporterDiagnostics();
  const received = vi.fn();
  const snapshot = {
    sessions: { running: 1, queued: 0 },
    work: { agentRuns: 1, chatRuns: 1, queuedTurns: 0 },
  };
  publishGatewayWorkMetrics(snapshot);
  try {
    diagnostics.onGatewayWorkMetrics!(received);
    expect(received.mock.calls).toEqual([[snapshot]]);
    expect(hasGatewayWorkMetricsListeners()).toBe(true);
    publishGatewayWorkMetrics(undefined);
    expect(received.mock.calls).toEqual([[snapshot], [undefined]]);
    lease.revoke();
    expect(hasGatewayWorkMetricsListeners()).toBe(false);
    publishGatewayWorkMetrics(snapshot);
    expect(received).toHaveBeenCalledTimes(2);
    expect(() => diagnostics.onGatewayWorkMetrics!(received)).toThrow("no longer active");
  } finally {
    lease.revoke();
  }
});

it("delivers worker metrics without diagnostic events while preserving requested events", async () => {
  const { lease, diagnostics } = createExporterDiagnostics();
  let now = 100;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  const received = vi.fn();
  try {
    diagnostics.onWorkerRequestMetrics?.(() => {
      throw new Error("Synthetic exporter failure");
    });
    diagnostics.onWorkerRequestMetrics?.(received);
    expect(hasInternalDiagnosticEventInterest("worker.request", true)).toBe(false);
    const request = trackWorkerRequest("sqlite_writer", "sessions");
    now = 101;
    const cancelled = new AbortController();
    const aborted = trackWorkerRequest("sqlite_writer", "private-request", cancelled.signal);
    now = 110;
    request.started();
    request.started();
    now = 111;
    cancelled.abort();
    aborted.started();
    aborted.completed();
    now = 135;
    request.completed();
    request.completed();
    expect(received.mock.calls).toEqual([
      ["sqlite_writer", "sessions", "queued", 1, undefined, undefined, undefined],
      ["sqlite_writer", "other", "queued", 2, undefined, undefined, undefined],
      ["sqlite_writer", "sessions", "started", 1, 10, undefined, undefined],
      ["sqlite_writer", "other", "completed", 0, undefined, undefined, { enqueued: 101 }],
      [
        "sqlite_writer",
        "sessions",
        "completed",
        0,
        undefined,
        25,
        { enqueued: 100, dispatched: 110 },
      ],
    ]);

    const events = vi.fn();
    diagnostics.onEvent(events, { include: ["worker.request"] });
    const observed = trackWorkerRequest("extension", "task");
    now = 140;
    observed.started();
    now = 150;
    observed.completed();
    await waitForDiagnosticEventsDrained();
    expect(events.mock.calls.map(([event]) => event)).toEqual([
      expect.objectContaining({
        type: "worker.request",
        kind: "extension",
        requestClass: "task",
        phase: "queued",
        queueDepth: 1,
      }),
      expect.objectContaining({ phase: "started", queueDepth: 0, queueWaitMs: 5 }),
      expect.objectContaining({ phase: "completed", queueDepth: 0, durationMs: 10 }),
    ]);
    expect(events.mock.calls.every(([, metadata]) => metadata.trusted)).toBe(true);
    expect(received).toHaveBeenCalledTimes(8);
  } finally {
    lease.revoke();
  }
});

it("keeps worker metric demand live across subscription, diagnostics disablement, and revocation", () => {
  const { lease, diagnostics } = createExporterDiagnostics();
  let now = 100;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  const request = trackWorkerRequest("extension", "task");
  const received = vi.fn();
  try {
    const unsubscribe = diagnostics.onWorkerRequestMetrics?.(received);
    now = 110;
    request.started();
    expect(received.mock.calls).toEqual([
      ["extension", "task", "started", 0, 10, undefined, undefined],
    ]);
    setDiagnosticsEnabledForProcess(false);
    request.completed();
    expect(received).toHaveBeenCalledTimes(1);
    setDiagnosticsEnabledForProcess(true);
    const next = trackWorkerRequest("extension", "task");
    expect(received).toHaveBeenCalledTimes(2);
    unsubscribe?.();
    unsubscribe?.();
    next.completed();
    expect(received).toHaveBeenCalledTimes(2);
    diagnostics.onWorkerRequestMetrics?.(received);
    lease.revoke();
    const retired = trackWorkerRequest("extension", "task");
    retired.started();
    retired.completed();
    expect(received).toHaveBeenCalledTimes(2);
    expect(() => diagnostics.onWorkerRequestMetrics?.(received)).toThrow("no longer active");
  } finally {
    request.completed();
    lease.revoke();
  }
});
