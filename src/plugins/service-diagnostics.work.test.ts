import { afterEach, expect, it, vi } from "vitest";
import {
  hasGatewayWorkMetricsListeners,
  publishGatewayWorkMetrics,
} from "../infra/gateway-work-metrics.js";
import { createPluginRuntimeCapabilityLease } from "./capability-lease.js";
import { createPluginServiceDiagnostics } from "./service-diagnostics.js";

afterEach(() => publishGatewayWorkMetrics(undefined));

it("replays owner work and revokes its subscription with the exporter capability", () => {
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
