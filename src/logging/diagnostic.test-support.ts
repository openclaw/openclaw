import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { resetDiagnosticMemoryForTest } from "./diagnostic-memory.js";
import { resetDiagnosticPhasesForTest } from "./diagnostic-phase.js";
import { resetDiagnosticRunActivityForTest } from "./diagnostic-run-activity.js";
import { resetDiagnosticActivityForTest } from "./diagnostic-runtime.js";
import { resetDiagnosticSessionStateForTest } from "./diagnostic-session-state.js";
import { resetDiagnosticStabilityRecorderForTest } from "./diagnostic-stability.js";
import { startGatewayDiagnosticHeartbeat, stopGatewayDiagnosticHeartbeat } from "./diagnostic.js";

export function startEnabledDiagnosticHeartbeatForTest(
  opts?: Parameters<typeof startGatewayDiagnosticHeartbeat>[2],
) {
  return startGatewayDiagnosticHeartbeat(
    createTestGatewayScheduler("fake-timers"),
    { diagnostics: { enabled: true } },
    {
      testTimings: { stuckSessionWarnMs: 30_000, stuckSessionAbortMs: 60_000 },
      recoverStuckSession: () => undefined,
      ...opts,
    },
  );
}

export function resetDiagnosticStateForTest(): void {
  stopGatewayDiagnosticHeartbeat();
  resetDiagnosticSessionStateForTest();
  resetDiagnosticActivityForTest();
  resetDiagnosticRunActivityForTest();
  resetDiagnosticMemoryForTest();
  resetDiagnosticPhasesForTest();
  resetDiagnosticStabilityRecorderForTest();
}
