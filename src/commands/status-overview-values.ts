import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { sanitizeTerminalText } from "../../packages/terminal-core/src/safe-text.js";
import type { HostDesktopStatus } from "../gateway/desktop/host-source.js";
import { redactSecretDegradationReason } from "../secrets/runtime-degraded-state.js";
import type { StatusSummary } from "../status/summary.js";
import { redactStatusSecrets } from "./status-redaction.js";

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

/** Combines Gateway-owned degradation with distinct command-local human diagnostics. */
export function buildStatusSecretDiagnostics(
  owners: NonNullable<StatusSummary["degradedSecretOwners"]>,
  diagnostics: string[],
): string[] {
  const safeText = (value: string) =>
    truncateUtf16Safe(redactStatusSecrets(sanitizeTerminalText(redactStatusSecrets(value))), 160);
  const ownerPaths = new Set(owners.flatMap((owner) => owner.paths));
  const ownerDiagnostics = new Map(
    owners.map((owner) => [
      `${owner.ownerKind}\0${owner.ownerId}`,
      `${owner.degradationState ?? "cold"} ${owner.ownerKind}:${safeText(owner.ownerId)} (${owner.paths.slice(0, 3).map(safeText).join(", ")}${owner.paths.length > 3 ? ", …" : ""}): ${redactSecretDegradationReason(owner.reason)}`,
    ]),
  );
  const localDiagnostics = diagnostics.filter((diagnostic) => {
    const ownerPath =
      /^.+?: (.+?) is unavailable in this command path(?:;|$)/.exec(diagnostic)?.[1] ??
      diagnostic.split(":", 1)[0];
    return ownerPath === undefined || !ownerPaths.has(ownerPath);
  });
  return [...ownerDiagnostics.values(), ...new Set(localDiagnostics.map(safeText))];
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
