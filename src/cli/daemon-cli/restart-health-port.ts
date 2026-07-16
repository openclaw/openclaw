// Port ownership and diagnostics helpers for gateway restart health checks.
import { formatPortDiagnostics, type PortUsage } from "../../infra/ports.js";
import type { GatewayPortHealthSnapshot, GatewayRestartSnapshot } from "./restart-health.js";

export function hasListenerAttributionGap(portUsage: PortUsage): boolean {
  // lsof/netstat may report a busy port without a PID; keep that distinct from a free port.
  if (portUsage.status !== "busy" || portUsage.listeners.length > 0) {
    return false;
  }
  if (portUsage.errors?.length) {
    return true;
  }
  return portUsage.hints.some((hint) => hint.includes("process details are unavailable"));
}

export function listenerOwnedByRuntimePid(params: {
  listener: PortUsage["listeners"][number];
  runtimePid: number;
}): boolean {
  return params.listener.pid === params.runtimePid || params.listener.ppid === params.runtimePid;
}

function renderPortUsageDiagnostics(snapshot: GatewayPortHealthSnapshot): string[] {
  const lines: string[] = [];

  if (snapshot.portUsage.status === "busy") {
    lines.push(...formatPortDiagnostics(snapshot.portUsage));
  } else {
    lines.push(`Gateway port ${snapshot.portUsage.port} status: ${snapshot.portUsage.status}.`);
  }

  if (snapshot.portUsage.errors?.length) {
    lines.push(`Port diagnostics errors: ${snapshot.portUsage.errors.join("; ")}`);
  }

  return lines;
}

export function renderRestartDiagnostics(snapshot: GatewayRestartSnapshot): string[] {
  const lines: string[] = [];
  if (snapshot.versionMismatch) {
    const actual = snapshot.versionMismatch.actual ?? "unavailable";
    lines.push(
      `Gateway version mismatch: expected ${snapshot.versionMismatch.expected}, running gateway reported ${actual}.`,
    );
  }
  if (snapshot.activatedPluginErrors?.length) {
    lines.push("Activated plugin load errors:");
    for (const plugin of snapshot.activatedPluginErrors) {
      lines.push(`- ${plugin.id}: ${plugin.error}`);
    }
  }
  if (snapshot.channelProbeErrors?.length) {
    lines.push("Channel health probe errors:");
    for (const channel of snapshot.channelProbeErrors) {
      lines.push(`- ${channel.id}: ${channel.error}`);
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

  lines.push(...renderPortUsageDiagnostics(snapshot));

  return lines;
}

export function renderGatewayPortHealthDiagnostics(snapshot: GatewayPortHealthSnapshot): string[] {
  return renderPortUsageDiagnostics(snapshot);
}
