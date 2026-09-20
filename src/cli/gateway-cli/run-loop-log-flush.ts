import { flushDiagnosticsTimeline } from "../../infra/diagnostics-timeline.js";
import { flushLogger } from "../../logging/logger.js";

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
