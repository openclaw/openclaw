import { WindowsJob, retainCurrentProcessJobUntilExit } from "@openclaw/proc-safe/windows-job";

let retainedProcessJob = false;

// 2026.9.3–2026.9.9 and 2026.10.1-beta.1/beta.2 record this updater export.
// Remove it when those releases leave scripts/lib/update-compat-inventory.json.
export function retainWindowsProcessJobUntilExit(_legacyKoffi?: unknown): void {
  if (retainedProcessJob) {
    return;
  }
  const job = WindowsJob.create();
  try {
    retainCurrentProcessJobUntilExit(job);
    retainedProcessJob = true;
  } finally {
    job.close();
  }
}
