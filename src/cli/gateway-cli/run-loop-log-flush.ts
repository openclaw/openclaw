import { flushDiagnosticsTimeline } from "../../infra/diagnostics-timeline.js";
import {
  GATEWAY_SIGNAL_REPEAT_WINDOW_MS,
  formatGatewayRepeatedSignalHint,
} from "../../infra/gateway-boot-lifecycle.js";
import { flushLogger } from "../../logging/logger.js";
import type { SubsystemLogger } from "../../logging/subsystem.js";

export async function flushGatewayLogsBeforeExit(
  logger: { warn: (message: string) => void },
  timeoutMs = 4_000,
) {
  flushDiagnosticsTimeline();
  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  const flushed = await Promise.race([
    flushLogger().then(() => true),
    new Promise<false>((resolve) => {
      flushTimer = setTimeout(() => resolve(false), timeoutMs);
    }),
  ]);
  clearTimeout(flushTimer);
  if (!flushed) {
    logger.warn(`log flush did not settle within ${timeoutMs}ms; continuing shutdown`);
  }
}

export function createGatewaySignalObserver(logger: Pick<SubsystemLogger, "warn">) {
  const recentSignals = new Map<NodeJS.Signals, number[]>();
  return (signal: NodeJS.Signals) => {
    const now = Date.now();
    const times = (recentSignals.get(signal) ?? []).filter(
      (time) => now - time <= GATEWAY_SIGNAL_REPEAT_WINDOW_MS,
    );
    times.push(now);
    recentSignals.set(signal, times.slice(-3));
    if (times.length === 3) {
      logger.warn(formatGatewayRepeatedSignalHint(signal, 3));
    }
  };
}

export function createGatewayStabilityReporter(
  runtime: Pick<
    typeof import("./lifecycle.runtime.js"),
    "writeDiagnosticStabilityBundleForFailureSync"
  >,
  logger: Pick<SubsystemLogger, "warn">,
) {
  return (reason: string, error?: unknown, shutdownStep?: string) => {
    const result = runtime.writeDiagnosticStabilityBundleForFailureSync(
      reason,
      error,
      ...(shutdownStep ? [{ shutdownStep }] : []),
    );
    if ("message" in result) {
      logger.warn(result.message);
    }
  };
}
