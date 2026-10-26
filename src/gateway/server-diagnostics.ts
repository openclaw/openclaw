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
import type { GatewayEventLoopHealth } from "./server/event-loop-health.js";

const QA_DIAGNOSTIC_ABORT_MS_ENV = "QA_DIAGNOSTIC_STUCK_SESSION_ABORT_MS";
const MIN_QA_DIAGNOSTIC_ABORT_MS = 30_000;

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
    setDiagnosticsEnabledForProcess(isDiagnosticsEnabled(config));
    notifyGatewayWorkMetricsChanged();
    const raw =
      process.env.OPENCLAW_ENABLE_PRIVATE_QA_CLI === "1" &&
      process.env.OPENCLAW_GATEWAY_HOST_LIFELINE?.trim() === "stdin"
        ? process.env[QA_DIAGNOSTIC_ABORT_MS_ENV]?.trim()
        : undefined;
    const stuckSessionAbortMs = raw && /^\d+$/.test(raw) ? Number(raw) : undefined;
    const testTimings =
      stuckSessionAbortMs !== undefined &&
      Number.isSafeInteger(stuckSessionAbortMs) &&
      stuckSessionAbortMs >= MIN_QA_DIAGNOSTIC_ABORT_MS
        ? {
            stuckSessionWarnMs: Math.max(15_000, Math.floor(stuckSessionAbortMs / 2)),
            stuckSessionAbortMs,
          }
        : undefined;
    startGatewayDiagnosticHeartbeat(params.scheduler, undefined, {
      getConfig: getRuntimeConfig,
      startupGraceMs: 60_000,
      testTimings,
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
