import { formatDirectCommandResult, type DirectCommandResultObject } from "./direct-command.js";

export function resolveDirectCommandDeliveryBestEffort(job: {
  delivery?: { bestEffort?: boolean };
}): boolean {
  return job.delivery?.bestEffort === true;
}

export function formatDirectCommandDeliveryMessage(params: {
  jobName: string;
  result: DirectCommandResultObject;
}): string {
  const name = params.jobName.trim() || "directCommand";
  return `[cron:${name}] ${formatDirectCommandResult(params.result)}`;
}
