import { formatPortDiagnostics } from "../../infra/ports-format.js";
import type {
  GatewayPortHealthSnapshot,
  GatewayRestartSnapshot,
  GatewayRestartWaitOutcome,
} from "./restart-health.types.js";

const restartFailureReasons: Partial<Record<GatewayRestartWaitOutcome, string>> = {
  "plugin-errors": "activated plugins reported load errors",
  "channel-errors": "channel health checks failed",
  "version-mismatch": "the running Gateway version did not match the expected version",
  "build-id-mismatch": "the running Gateway build did not match the expected build",
  "stale-pids": "stale Gateway processes remained",
  "generation-changed": "the Gateway process generation changed before readiness was confirmed",
  "service-definition-refused": "the service definition refused startup",
};

function formatGatewayStillStarting(snapshot: GatewayRestartSnapshot): string {
  return `Gateway service is still starting after ${Math.round((snapshot.elapsedMs ?? 0) / 1000)}s. Last observed startup phase: ${snapshot.startupPhase ?? "unknown"}. Run openclaw gateway status --deep.`;
}

export function renderGatewayPortHealthDiagnostics(snapshot: GatewayPortHealthSnapshot): string[] {
  const lines: string[] = [];
  if (snapshot.portUsage.status === "busy") {
    lines.push(...formatPortDiagnostics(snapshot.portUsage));
  } else {
    lines.push(`Gateway port ${snapshot.portUsage.port} status: ${snapshot.portUsage.status}.`);
  }
  if (snapshot.portUsage.errors?.length) {
    lines.push(`Port diagnostics errors: ${snapshot.portUsage.errors.join("; ")}`);
  }
  if (snapshot.probeError) {
    lines.push(`Gateway probe failed: ${snapshot.probeError}`);
  }
  return lines;
}

export function renderRestartDiagnostics(snapshot: GatewayRestartSnapshot): string[] {
  const lines: string[] = [];
  const refusal = snapshot.runtime?.systemd?.startRefusal;
  if (refusal) {
    lines.push(`SERVICE-DEFINITION: ${refusal.message}`);
  }
  if (snapshot.waitOutcome === "still-starting") {
    lines.push(formatGatewayStillStarting(snapshot));
  }
  if (snapshot.waitOutcome === "timeout" && snapshot.startupPhase) {
    lines.push(
      `Readiness budget exhausted after ${Math.round((snapshot.elapsedMs ?? 0) / 1000)}s. Last observed startup phase: ${snapshot.startupPhase}.`,
    );
  }
  if (snapshot.waitOutcome === "generation-changed") {
    lines.push("Gateway process generation changed before readiness could be confirmed.");
  }
  for (const [kind, mismatch] of [
    ["version", snapshot.versionMismatch],
    ["build", snapshot.buildIdMismatch],
  ] as const) {
    if (mismatch) {
      lines.push(
        `Gateway ${kind} mismatch: expected ${mismatch.expected}, running gateway reported ${mismatch.actual ?? "unavailable"}.`,
      );
    }
  }
  for (const [heading, errors] of [
    ["Activated plugin load errors:", snapshot.activatedPluginErrors],
    ["Channel health probe errors:", snapshot.channelProbeErrors],
  ] as const) {
    if (errors?.length) {
      lines.push(heading);
      for (const { id, error } of errors) {
        lines.push(`- ${id}: ${error}`);
      }
    }
  }
  const runtimeSummary = [
    snapshot.runtime.status ? `status=${snapshot.runtime.status}` : null,
    snapshot.runtime.state ? `state=${snapshot.runtime.state}` : null,
    snapshot.runtime.pid != null ? `pid=${snapshot.runtime.pid}` : null,
    snapshot.runtime.lastExitStatus != null ? `lastExit=${snapshot.runtime.lastExitStatus}` : null,
  ]
    .filter(Boolean)
    .join(", ");
  if (runtimeSummary) {
    lines.push(`Service runtime: ${runtimeSummary}`);
  }
  lines.push(...renderGatewayPortHealthDiagnostics(snapshot));
  return lines;
}

export function formatGatewayRestartFailure(params: {
  health: GatewayRestartSnapshot;
  port: number;
  defaultTimeoutSeconds: number;
}): { statusLine: string; failMessage: string } {
  const refusal = params.health.runtime?.systemd?.startRefusal;
  if (params.health.waitOutcome === "service-definition-refused" && refusal) {
    const message = `SERVICE-DEFINITION: ${refusal.message}`;
    return { statusLine: message, failMessage: message };
  }
  if (params.health.waitOutcome === "still-starting") {
    const message = formatGatewayStillStarting(params.health);
    return { statusLine: message, failMessage: message };
  }
  if (params.health.waitOutcome === "stopped-free") {
    const elapsedSeconds = Math.max(1, Math.round((params.health.elapsedMs ?? 0) / 1000));
    return {
      statusLine: `Gateway restart failed after ${elapsedSeconds}s: service stayed stopped and port ${params.port} stayed free.`,
      failMessage: `Gateway restart failed after ${elapsedSeconds}s: service stayed stopped and health checks never came up.`,
    };
  }
  const reason = params.health.waitOutcome && restartFailureReasons[params.health.waitOutcome];
  if (reason) {
    const message = `Gateway restart failed: ${reason}.`;
    return { statusLine: message, failMessage: message };
  }
  const timeoutSeconds = Math.max(
    1,
    Math.round(
      params.health.elapsedMs === undefined
        ? params.defaultTimeoutSeconds
        : params.health.elapsedMs / 1000,
    ),
  );
  return {
    statusLine: `Timed out after ${timeoutSeconds}s waiting for gateway port ${params.port} to become healthy.`,
    failMessage: `Gateway restart timed out after ${timeoutSeconds}s waiting for health checks.`,
  };
}
