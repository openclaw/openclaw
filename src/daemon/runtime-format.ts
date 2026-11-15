import { terminalText } from "../../packages/terminal-core/src/safe-text.js";
import { formatRuntimeStatusWithDetails } from "../infra/runtime-status.ts";
import { getSystemdCgroupHygieneSummary, type GatewayServiceRuntime } from "./service-runtime.js";

export function formatServiceLabel(label: string, runtime?: GatewayServiceRuntime): string {
  if (runtime?.inspectionReason === "service-manager-unavailable") {
    return "no supported service manager detected";
  }
  return runtime?.systemd?.scope ? `systemd ${runtime.systemd.scope}` : label;
}

// Windows and systemd expose signal exits as numeric status codes.
const SIGNAL_NAMES_BY_STATUS = new Map<number, string>([
  [129, "SIGHUP"],
  [130, "SIGINT"],
  [131, "SIGQUIT"],
  [134, "SIGABRT/abort"],
  [137, "SIGKILL"],
  [143, "SIGTERM"],
]);

function formatLastExitStatus(status: number): string {
  // Service managers usually report signal exits as 128 + signal number.
  const signalName = SIGNAL_NAMES_BY_STATUS.get(status);
  return signalName ? `last exit ${status} (${signalName})` : `last exit ${status}`;
}

export function formatRuntimeStatus(runtime: GatewayServiceRuntime | undefined): string | null {
  if (!runtime) {
    return null;
  }
  const cgroupSummary = getSystemdCgroupHygieneSummary(runtime.systemd);
  const details = [
    runtime.subState ? terminalText`sub ${runtime.subState}` : undefined,
    runtime.lastExitStatus !== undefined ? formatLastExitStatus(runtime.lastExitStatus) : undefined,
    runtime.lastExitReason ? terminalText`reason ${runtime.lastExitReason}` : undefined,
    runtime.lastRunResult ? terminalText`last run ${runtime.lastRunResult}` : undefined,
    runtime.lastRunTime ? terminalText`last run time ${runtime.lastRunTime}` : undefined,
    cgroupSummary ? terminalText`${cgroupSummary}` : cgroupSummary,
    runtime.detail ? terminalText`${runtime.detail.replace(/\s+/g, " ").trim()}` : runtime.detail,
  ].filter((detail): detail is string => Boolean(detail));
  return formatRuntimeStatusWithDetails({
    status: runtime.status ? terminalText`${runtime.status}` : runtime.status,
    pid: runtime.pid,
    state: runtime.state ? terminalText`${runtime.state}` : runtime.state,
    details,
  });
}
