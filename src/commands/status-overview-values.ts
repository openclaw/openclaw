import type { HostDesktopStatus } from "../gateway/desktop/host-source.js";

export function formatHostDesktopStatus(status?: HostDesktopStatus): string {
  if (!status || status.state === "disabled") {
    return "disabled";
  }
  if (status.state === "managed") {
    return status.managedState === "running"
      ? `managed · running · display :${status.display} · 127.0.0.1:${status.port} · security VncAuth`
      : status.managedState === "failed"
        ? `managed · failed: ${status.error}`
        : status.managedState === "unknown"
          ? "managed · runtime state unavailable"
          : `managed · ${status.managedState === "not-started" ? "not started" : "starting"}`;
  }
  return `${status.state} · 127.0.0.1:${status.port}${status.security ? ` · security ${status.security}` : ""}`;
}

export function countActiveStatusAgents(params: {
  agentStatus: {
    agents: Array<{
      id: string;
      lastActiveAgeMs?: number | null;
    }>;
  };
  activeThresholdMs?: number;
}) {
  const activeThresholdMs = params.activeThresholdMs ?? 10 * 60_000;
  // "Active" means a recent session update, not merely a configured agent.
  return params.agentStatus.agents.filter(
    (agent) => agent.lastActiveAgeMs != null && agent.lastActiveAgeMs <= activeThresholdMs,
  ).length;
}
