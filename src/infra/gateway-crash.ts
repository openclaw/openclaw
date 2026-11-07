import { formatDurationCompact } from "./format-time/format-duration.js";
import type { GatewayOwnerSupervisor } from "./gateway-owner-lease.types.js";

export const GATEWAY_CRASH_STATE_KEY = "gateway.crashes";

export type GatewayCrashEvidence = {
  reason?: string;
  signal?: string;
  exitCode?: number;
  lastHeartbeatAtMs?: number;
  uptimeMs?: number;
};

export type GatewayRunMetadata = {
  version?: string;
  commit?: string;
  runtime?: string;
  supervisor?: GatewayOwnerSupervisor;
  systemdInvocationId?: string;
};

export type GatewayCrashRecord = GatewayRunMetadata &
  GatewayCrashEvidence & {
    bootId: string;
    pid: number;
    startedAtMs: number;
    detectedAtMs: number;
  };

export type GatewayCrashState = {
  // Metadata augments the boot receipt; only gateway_boot_lifecycle decides whether it closed.
  active?: GatewayRunMetadata & { bootId: string; pid: number; lastHeartbeatAtMs?: number };
  recent: GatewayCrashRecord[];
};

let recentCrashes: GatewayCrashRecord[] = [];

/** Published only by the boot lifecycle writer's committed mutation replies. */
export function publishGatewayRecentCrashes(crashes: GatewayCrashRecord[]): void {
  recentCrashes = crashes;
}

export function getGatewayRecentCrashes(): readonly GatewayCrashRecord[] {
  return recentCrashes;
}

export function formatGatewayCrash(crash: GatewayCrashRecord): string {
  const cause = crash.signal
    ? `signal ${crash.signal}`
    : crash.exitCode !== undefined
      ? `exit ${crash.exitCode}`
      : (crash.reason ?? "cause unknown");
  const uptime = formatDurationCompact(crash.uptimeMs);
  const heartbeatAge =
    crash.lastHeartbeatAtMs === undefined
      ? undefined
      : formatDurationCompact(crash.lastHeartbeatAtMs - crash.startedAtMs);
  const duration = uptime
    ? ` after ${uptime}`
    : heartbeatAge
      ? `, last heartbeat after ${heartbeatAge}`
      : "";
  const reason =
    crash.reason && (crash.signal || crash.exitCode !== undefined) ? ` (${crash.reason})` : "";
  return `${cause}${reason}${duration}, version ${crash.version ?? "unknown"}${crash.commit ? ` (${crash.commit})` : ""}`;
}
