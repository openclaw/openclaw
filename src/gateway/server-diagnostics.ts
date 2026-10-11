import { getRuntimeConfig } from "../config/io.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  isDiagnosticsEnabled,
  setDiagnosticsEnabledForProcess,
} from "../infra/diagnostic-events.js";
import type { GatewayScheduler } from "../infra/gateway-scheduler.js";
import { notifyGatewayWorkMetricsChanged } from "../infra/gateway-work-metrics-events.js";
import {
  startGatewayDiagnosticHeartbeat,
  stopGatewayDiagnosticHeartbeat,
} from "../logging/diagnostic.js";
import { resolveQaDiagnosticHeartbeatTimings } from "./server-qa-diagnostic-timings.js";
import type { GatewayEventLoopHealth } from "./server/event-loop-health.js";

/** The Gateway lifetime owns diagnostics configuration and its heartbeat job. */
export function createGatewayDiagnosticsConfigurator(params: {
  scheduler: GatewayScheduler;
  isClosing: () => boolean;
  sampleLiveness: () => GatewayEventLoopHealth | undefined;
}) {
  stopGatewayDiagnosticHeartbeat();
  return (config: OpenClawConfig) => {
    if (params.isClosing()) {
      return;
    }
    const enabled = isDiagnosticsEnabled(config);
    setDiagnosticsEnabledForProcess(enabled);
    notifyGatewayWorkMetricsChanged();
    if (!enabled) {
      stopGatewayDiagnosticHeartbeat();
      return;
    }
    startGatewayDiagnosticHeartbeat(params.scheduler, undefined, {
      getConfig: getRuntimeConfig,
      startupGraceMs: 60_000,
      testTimings: resolveQaDiagnosticHeartbeatTimings(process.env),
      sampleLiveness: () => {
        const sample = params.sampleLiveness();
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
