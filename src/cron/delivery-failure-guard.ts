import type { CronJob } from "./types.js";

/**
 * Configuration for automatic disabling of cron jobs after delivery failures.
 */
export const DELIVERY_FAILURE_GUARD_CONFIG = {
  /**
   * Number of consecutive delivery failures before auto-disabling the job.
   * Set to 0 to disable auto-disable feature.
   */
  consecutiveFailureThreshold: 3,

  /**
   * Whether to send a notification when a job is auto-disabled.
   */
  notifyOnDisable: true,
};

/**
 * Checks if a cron job should be auto-disabled based on delivery failures.
 *
 * A job is marked for auto-disable when:
 * 1. It has a delivery configuration (delivery.mode !== "none")
 * 2. The last delivery status was "not-delivered"
 * 3. consecutiveErrors >= configured threshold
 * 4. Job is currently enabled
 *
 * Returns true if the job meets all criteria and should be disabled.
 */
export function shouldAutoDisableOnDeliveryFailure(job: CronJob): boolean {
  const { consecutiveFailureThreshold } = DELIVERY_FAILURE_GUARD_CONFIG;

  // If threshold is 0 or less, auto-disable is disabled
  if (consecutiveFailureThreshold <= 0) {
    return false;
  }

  // Only consider enabled jobs
  if (!job.enabled) {
    return false;
  }

  // Only consider jobs with delivery configured
  if (!job.delivery || job.delivery.mode === "none") {
    return false;
  }

  // Check if last delivery failed
  const lastDeliveryFailed = job.state.lastDeliveryStatus === "not-delivered";
  if (!lastDeliveryFailed) {
    return false;
  }

  // Check if consecutive errors meet threshold
  const consecutiveErrors = job.state.consecutiveErrors ?? 0;
  return consecutiveErrors >= consecutiveFailureThreshold;
}

/**
 * Builds a notification message for auto-disabled jobs.
 */
export function buildAutoDisableNotification(job: CronJob): string {
  const consecutiveErrors = job.state.consecutiveErrors ?? 0;
  const lastError = job.state.lastDeliveryError || job.state.lastError || "unknown error";

  return (
    `🔴 **Cron Job Auto-Disabled**\n\n` +
    `**Job:** ${job.name}\n` +
    `**ID:** \`${job.id}\`\n` +
    `**Reason:** Delivery failed ${consecutiveErrors} consecutive times\n` +
    `**Last Error:** ${lastError}\n\n` +
    `This job has been automatically disabled to prevent further silent failures. ` +
    `Check your delivery configuration and re-enable it manually when ready.`
  );
}

/**
 * Resets delivery failure tracking on successful execution.
 */
export function resetDeliveryFailureState(job: CronJob): void {
  // consecutiveErrors will be reset elsewhere in the job execution flow
  // This is a helper for explicitly resetting delivery-related state
  job.state.lastDeliveryError = undefined;
  job.state.lastDeliveryStatus = "unknown";
}
