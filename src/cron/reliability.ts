import type { CronJob, CronRunStatus } from "./types.js";

/**
 * Cron job execution state for diagnostics.
 */
export interface CronJobExecutionState {
  jobId: string;
  jobName: string;
  status: CronRunStatus;
  scheduledTime: number;
  startedAt?: number;
  endedAt?: number;
  error?: string;
  retryCount?: number;
}

/**
 * Cron reliability metrics for monitoring.
 */
export interface CronReliabilityMetrics {
  totalJobs: number;
  enabledJobs: number;
  runningJobs: number;
  stuckJobs: number;
  failedJobs: number;
  averageExecutionTimeMs: number;
  lastFailureTime?: number;
}

/**
 * Configuration for cron reliability monitoring.
 */
export interface CronReliabilityConfig {
  /** Maximum time (ms) before considering a job as stuck. Default: 2 hours */
  stuckThresholdMs?: number;
  /** Enable automatic stuck job detection. Default: true */
  detectStuckJobs?: boolean;
  /** Enable failure alerting. Default: true */
  alertOnFailure?: boolean;
}

const DEFAULT_STUCK_THRESHOLD_MS = 2 * 60 * 60 * 1000; // 2 hours

/**
 * Resolve the stuck threshold for job execution.
 */
export function resolveStuckThresholdMs(config?: CronReliabilityConfig): number {
  return config?.stuckThresholdMs ?? DEFAULT_STUCK_THRESHOLD_MS;
}

/**
 * Check if a cron job is stuck (running too long).
 */
export function isJobStuck(job: CronJob, nowMs: number, config?: CronReliabilityConfig): boolean {
  // Job is stuck if it's currently running (has runningAtMs) and has been running too long
  if (!job.state.runningAtMs) {
    return false;
  }

  const threshold = resolveStuckThresholdMs(config);
  return nowMs - job.state.runningAtMs > threshold;
}

/**
 * Format a cron job execution state for logging.
 */
export function formatCronJobState(state: CronJobExecutionState): string {
  const lines: string[] = [`Job: ${state.jobName} (${state.jobId})`, `Status: ${state.status}`];

  if (state.startedAt) {
    lines.push(`Started: ${new Date(state.startedAt).toISOString()}`);
  }

  if (state.endedAt) {
    lines.push(`Ended: ${new Date(state.endedAt).toISOString()}`);
    const duration = state.endedAt - (state.startedAt ?? state.endedAt);
    lines.push(`Duration: ${formatDuration(duration)}`);
  }

  if (state.error) {
    lines.push(`Error: ${state.error}`);
  }

  if (state.retryCount && state.retryCount > 0) {
    lines.push(`Retries: ${state.retryCount}`);
  }

  return lines.join("\n");
}

/**
 * Format milliseconds to human-readable duration.
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${ms}ms`;
  }
  if (ms < 60_000) {
    return `${(ms / 1000).toFixed(1)}s`;
  }
  if (ms < 3600_000) {
    return `${(ms / 60_000).toFixed(1)}m`;
  }
  return `${(ms / 3600_000).toFixed(1)}h`;
}

/**
 * Extract error information from a cron job failure.
 */
export function extractCronJobError(job: CronJob): string | undefined {
  if (job.state.lastRunStatus === "error" && job.state.lastError) {
    return job.state.lastError;
  }
  return undefined;
}

/**
 * Calculate reliability metrics from cron jobs.
 */
export function calculateCronReliabilityMetrics(
  jobs: CronJob[],
  nowMs: number,
  config?: CronReliabilityConfig,
): CronReliabilityMetrics {
  const enabledJobs = jobs.filter((j) => j.enabled);
  const runningJobs = enabledJobs.filter((j) => j.state.runningAtMs != null);
  const stuckJobs = runningJobs.filter((j) => isJobStuck(j, nowMs, config));
  const failedJobs = enabledJobs.filter((j) => j.state.lastRunStatus === "error");

  // Calculate average execution time from successful jobs (lastRunStatus === "ok")
  const successfulJobs = enabledJobs.filter(
    (j) => j.state.lastRunStatus === "ok" && j.state.lastDurationMs,
  );
  let averageExecutionTimeMs = 0;
  if (successfulJobs.length > 0) {
    const totalTime = successfulJobs.reduce((sum, j) => {
      return sum + (j.state.lastDurationMs ?? 0);
    }, 0);
    averageExecutionTimeMs = totalTime / successfulJobs.length;
  }

  // Find last failure time
  const failedWithTime = failedJobs.filter((j) => j.state.lastRunAtMs);
  const lastFailed = failedWithTime.toSorted(
    (a, b) => (b.state.lastRunAtMs ?? 0) - (a.state.lastRunAtMs ?? 0),
  )[0];
  const lastFailureTime = lastFailed?.state.lastRunAtMs;

  return {
    totalJobs: jobs.length,
    enabledJobs: enabledJobs.length,
    runningJobs: runningJobs.length,
    stuckJobs: stuckJobs.length,
    failedJobs: failedJobs.length,
    averageExecutionTimeMs,
    lastFailureTime,
  };
}

/**
 * Format cron reliability metrics for display.
 */
export function formatCronReliabilityMetrics(metrics: CronReliabilityMetrics): string {
  const lines: string[] = [
    `Total Jobs: ${metrics.totalJobs}`,
    `Enabled: ${metrics.enabledJobs}`,
    `Running: ${metrics.runningJobs}`,
    `Stuck: ${metrics.stuckJobs}`,
    `Failed: ${metrics.failedJobs}`,
  ];

  if (metrics.averageExecutionTimeMs > 0) {
    lines.push(`Avg Execution Time: ${formatDuration(metrics.averageExecutionTimeMs)}`);
  }

  if (metrics.lastFailureTime) {
    lines.push(`Last Failure: ${new Date(metrics.lastFailureTime).toISOString()}`);
  }

  return lines.join("\n");
}

/**
 * Check if a cron job needs attention.
 */
export function cronJobNeedsAttention(
  job: CronJob,
  nowMs: number,
  config?: CronReliabilityConfig,
): boolean {
  // Job is stuck
  if (isJobStuck(job, nowMs, config)) {
    return true;
  }

  // Job has failed (lastRunStatus === "error")
  if (job.state.lastRunStatus === "error") {
    return true;
  }

  // Job is disabled and has pending runs (no lastRunStatus means never run or pending)
  if (!job.enabled && !job.state.lastRunStatus && job.state.nextRunAtMs) {
    return true;
  }

  return false;
}

/**
 * Get recommended actions for a problematic cron job.
 */
export function getCronJobRecommendations(job: CronJob): string[] {
  const recommendations: string[] = [];

  if (job.state.lastRunStatus === "error" && job.state.lastError) {
    const error = extractCronJobError(job);
    if (error) {
      recommendations.push(`Check job error: ${error}`);
    }
    recommendations.push("Review logs for more details");
    recommendations.push("Consider increasing timeout if job takes too long");
  }

  if (job.state.runningAtMs && !job.state.lastDurationMs) {
    recommendations.push("Job may be stuck in queue - try restarting");
  }

  if (!job.enabled) {
    recommendations.push("Job is disabled - enable with: openclaw cron enable <job-id>");
  }

  if (job.schedule.kind === "cron" && !job.schedule.cron) {
    recommendations.push("Job has invalid cron schedule - check configuration");
  }

  return recommendations;
}
