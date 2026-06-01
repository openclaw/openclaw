/**
 * Lightweight gateway shutdown lifecycle state.
 *
 * Separated from `server-close.ts` so callers that only need the running /
 * shutting-down distinction (gateway startup, HTTP probe handler) do not pull
 * in the close-handler dependency graph (agent, channel, plugin cleanup). The
 * close handler itself imports from this module to flip the state.
 *
 * Per ClawSweeper review on #88908: keeping shutdown state out of the close
 * runtime so startup imports stay narrow.
 */

import { createSubsystemLogger } from "../logging/subsystem.js";

const gatewayShutdownProbeLog = createSubsystemLogger("gateway/probe");

let gatewayShuttingDownState: "running" | "shutting_down" = "running";

// One-shot dedupe for the strict-mode 503 response log. Reset on every state
// transition so subsequent in-process shutdown cycles each emit the signal
// exactly once. Per ClawSweeper review P3 on #88908: without resetting per
// cycle, the second SIGUSR1 restart's shutdown would be silent.
let shuttingDownResponseLogged = false;

export function markGatewayShuttingDown(): void {
  gatewayShuttingDownState = "shutting_down";
  // Fresh shutdown cycle: clear the once-per-shutdown probe log dedupe so
  // the next strict-mode 503 emits the signal again.
  shuttingDownResponseLogged = false;
}

export function isGatewayShuttingDown(): boolean {
  return gatewayShuttingDownState === "shutting_down";
}

// Called by gateway startup (and in-process restart) to flip the state back to
// running before /healthz starts answering 200 again. Also resets the probe
// log dedupe so the next shutdown cycle emits cleanly.
export function resetGatewayShuttingDownState(): void {
  gatewayShuttingDownState = "running";
  shuttingDownResponseLogged = false;
}

export function resetGatewayShuttingDownForTest(): void {
  resetGatewayShuttingDownState();
}

export function noteShuttingDownProbeResponse(requestPath: string): void {
  if (shuttingDownResponseLogged) {
    return;
  }
  shuttingDownResponseLogged = true;
  gatewayShutdownProbeLog.warn(
    `gateway.healthz.shutting_down_response path=${requestPath}; returning 503 so supervised lock recovery treats this gateway as draining`,
  );
}

export function resetShuttingDownProbeResponseLogForTest(): void {
  shuttingDownResponseLogged = false;
}
