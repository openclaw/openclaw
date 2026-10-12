// Config-driven cron job families the gateway converges on every cron start and
// on reloads that request `reconcileSystemJobs`, in this order.
import { reconcileHeartbeatMonitorJobs } from "../cron/heartbeat-monitor.js";
import { reconcileOrphanedMemoryDreamingJobs } from "./server-cron-memory-dreaming-jobs.js";

export const SYSTEM_JOB_RECONCILERS = [
  reconcileHeartbeatMonitorJobs,
  reconcileOrphanedMemoryDreamingJobs,
] as const;
