import { getRuntimeConfig } from "../config/io.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  isDiagnosticsEnabled,
  setDiagnosticsEnabledForProcess,
} from "../infra/diagnostic-events.js";
import {
  startGatewayDiagnosticHeartbeat,
  stopGatewayDiagnosticHeartbeat,
} from "../logging/diagnostic.js";
import { resolveQaDiagnosticHeartbeatTimings } from "./server-qa-diagnostic-timings.js";
import type { prepareGatewayKernelState } from "./server-runtime-state-prepare.js";

export function createGatewayDiagnostics(
  runtime: Pick<
    Awaited<ReturnType<typeof prepareGatewayKernelState>>,
    "lifecycle" | "scheduler" | "readinessEventLoopHealth"
  >,
) {
  const { lifecycle, readinessEventLoopHealth } = runtime;
  stopGatewayDiagnosticHeartbeat();
  return (config: OpenClawConfig) => {
    if (lifecycle.closePreludeStarted) {
      return;
    }
    const enabled = isDiagnosticsEnabled(config);
    setDiagnosticsEnabledForProcess(enabled);
    if (!enabled) {
      stopGatewayDiagnosticHeartbeat();
      return;
    }
    // Gateway lifecycle owns both this heartbeat job and the monitor
    // it samples, so startup failure and normal close tear them down together.
    startGatewayDiagnosticHeartbeat(runtime.scheduler, undefined, {
      getConfig: getRuntimeConfig,
      startupGraceMs: 60_000,
      testTimings: resolveQaDiagnosticHeartbeatTimings(process.env),
      sampleLiveness: () => {
        const sample = readinessEventLoopHealth.persistentDegradationSnapshot();
        if (!sample || sample.degradedSinceMs == null) {
          return null;
        }
        return {
          reasons: sample.reasons,
          intervalMs: sample.intervalMs,
          degradedSinceMs: sample.degradedSinceMs,
          eventLoopDelayP99Ms: sample.delayP99Ms,
          eventLoopDelayMaxMs: sample.delayMaxMs,
          eventLoopUtilization: sample.utilization,
          cpuCoreRatio: sample.cpuCoreRatio,
        };
      },
    });
  };
}
