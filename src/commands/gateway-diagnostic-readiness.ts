import { sanitizeTerminalText } from "../../packages/terminal-core/src/safe-text.js";
import { waitForGatewayDiagnosticReadiness } from "../cli/daemon-cli/diagnostic-readiness.js";
import { DEFAULT_RESTART_HEALTH_TIMEOUT_MS } from "../cli/daemon-cli/restart-health.constants.js";
import { buildGatewayProbeConnectionDetails } from "../gateway/call.js";
import { GatewayTransportError } from "../gateway/transport-error.js";
import { type RuntimeEnv, writeRuntimeJson } from "../runtime.js";

/** Keep startup progress separate from terminal diagnostic failure. */
export async function waitForGatewayDiagnostic(
  opts: Parameters<typeof waitForGatewayDiagnosticReadiness>[0] & { json?: boolean },
  runtime: RuntimeEnv,
): Promise<number | undefined> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_RESTART_HEALTH_TIMEOUT_MS;
  const readiness = await waitForGatewayDiagnosticReadiness({
    ...opts,
    onProgress: (phase) => {
      if (!opts.json) {
        runtime.log(`Gateway is still starting (phase: ${sanitizeTerminalText(phase)}).`);
      }
    },
  });
  if (!readiness) {
    return timeoutMs;
  }
  // RPC timeout fields require integer milliseconds.
  const remainingMs = Math.ceil(timeoutMs - (readiness.elapsedMs ?? 0));
  if (
    remainingMs > 0 &&
    (readiness.healthy ||
      readiness.waitOutcome === "channel-errors" ||
      readiness.waitOutcome === "plugin-errors")
  ) {
    return remainingMs;
  }
  if (readiness.waitOutcome === "still-starting") {
    if (opts.json) {
      writeRuntimeJson(runtime, {
        status: "starting",
        startupPhase: readiness.startupPhase,
      });
    }
    return undefined;
  }
  throw new GatewayTransportError({
    kind: "timeout",
    timeoutMs,
    connectionDetails: await buildGatewayProbeConnectionDetails(opts),
    message: `${readiness.healthy ? "Gateway diagnostic budget exhausted" : "Gateway not reachable"} after waiting ${Math.round((readiness.elapsedMs ?? 0) / 1000)} s.\n${sanitizeTerminalText(readiness.probeError ?? readiness.startupPhase ?? "Readiness could not be confirmed.")}\nRun openclaw gateway status --deep to diagnose.`,
  });
}
