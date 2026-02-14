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
  const status = runtime.status ?? "unknown";
  const details: string[] = [];
  if (runtime.pid) {
    details.push(`pid ${runtime.pid}`);
  }
  if (runtime.state && runtime.state.toLowerCase() !== status) {
    details.push(`state ${runtime.state}`);
  }
  if (runtime.subState) {
    details.push(`sub ${runtime.subState}`);
  }
  if (runtime.lastExitStatus !== undefined) {
    details.push(`last exit ${runtime.lastExitStatus}`);
  }
  if (runtime.lastExitReason) {
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
  return details.length > 0 ? `${status} (${details.join(", ")})` : status;
}
