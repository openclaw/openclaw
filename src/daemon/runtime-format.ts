import { formatRuntimeStatusWithDetails } from "../infra/runtime-status.ts";

export type ServiceRuntimeLike = {
  status?: string;
  state?: string;
  subState?: string;
  pid?: number;
  lastExitStatus?: number;
  lastExitReason?: string;
  lastRunResult?: string;
  lastRunTime?: string;
  detail?: string;
};

export function formatRuntimeStatus(runtime: ServiceRuntimeLike | undefined): string | null {
  if (!runtime) {
    return null;
  }
  const details: string[] = [];
  if (runtime.subState) {
    details.push(`sub ${runtime.subState}`);
  }
  // Suppress stale exit details when the service is currently running —
  // systemd retains the previous exit info even after a successful restart,
  // which misleads users into thinking the active service has a problem.
  const isRunning = runtime.status === "running";
  if (runtime.lastExitStatus !== undefined && !isRunning) {
    details.push(`last exit ${runtime.lastExitStatus}`);
  }
  if (runtime.lastExitReason && !isRunning) {
    details.push(`reason ${runtime.lastExitReason}`);
  }
  if (runtime.lastRunResult) {
    details.push(`last run ${runtime.lastRunResult}`);
  }
  if (runtime.lastRunTime) {
    details.push(`last run time ${runtime.lastRunTime}`);
  }
  if (runtime.detail) {
    details.push(runtime.detail);
  }
  return formatRuntimeStatusWithDetails({
    status: runtime.status,
    pid: runtime.pid,
    state: runtime.state,
    details,
  });
}
