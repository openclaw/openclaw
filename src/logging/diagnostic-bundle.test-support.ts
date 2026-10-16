export function createDiagnosticBundleFixture() {
  return {
    version: 1,
    generatedAt: "2026-04-22T12:00:00.000Z",
    reason: "gateway.restart_startup_failed",
    process: { pid: 123, platform: "darwin", arch: "arm64", node: "24.14.1", uptimeMs: 1000 },
    host: { hostname: "<redacted-hostname>" },
    snapshot: {
      generatedAt: "2026-04-22T12:00:00.000Z",
      capacity: 1000,
      count: 1,
      dropped: 0,
      events: [{ seq: 1, ts: 1, type: "webhook.received" }],
      summary: { byType: { "webhook.received": 1 } },
    },
  };
}
import { resetDiagnosticEventsForTest } from "../infra/diagnostic-events.js";
import { uninstallDiagnosticStabilityFatalHook } from "./diagnostic-stability-bundle.js";
import { resetDiagnosticStabilityRecorderForTest } from "./diagnostic-stability.js";

export function resetDiagnosticBundleState() {
  resetDiagnosticEventsForTest();
  resetDiagnosticStabilityRecorderForTest();
  uninstallDiagnosticStabilityFatalHook();
}
