import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { startGatewayDiagnosticHeartbeat } from "./diagnostic.js";

export function startDiagnosticHeartbeatForTest(
  config?: Parameters<typeof startGatewayDiagnosticHeartbeat>[1],
  opts?: Parameters<typeof startGatewayDiagnosticHeartbeat>[2],
) {
  return startGatewayDiagnosticHeartbeat(createTestGatewayScheduler("fake-timers"), config, {
    testTimings: { stuckSessionWarnMs: 30_000, stuckSessionAbortMs: 60_000 },
    ...opts,
  });
}

export function startEnabledDiagnosticHeartbeatForTest(
  opts?: Parameters<typeof startGatewayDiagnosticHeartbeat>[2],
) {
  return startDiagnosticHeartbeatForTest({ diagnostics: { enabled: true } }, opts);
}

type DiagnosticTestApi = {
  resetDiagnosticStateForTest(): void;
  resolveStuckSessionAbortMs(stuckSessionWarnMs: number): number;
  resolveStuckSessionWarnMs(): number;
};

function getTestApi(): DiagnosticTestApi {
  return (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.diagnosticTestApi")
  ] as DiagnosticTestApi;
}

export function resetDiagnosticStateForTest(): void {
  getTestApi().resetDiagnosticStateForTest();
}

export function resolveStuckSessionAbortMs(stuckSessionWarnMs: number): number {
  return getTestApi().resolveStuckSessionAbortMs(stuckSessionWarnMs);
}

export function resolveStuckSessionWarnMs(): number {
  return getTestApi().resolveStuckSessionWarnMs();
}
