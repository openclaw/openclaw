/** The repair request the scheduler posts into a failing automation's owner conversation. */
import type { FailoverReason } from "../../agents/failover/signal.js";
import { wrapUntrustedPromptDataBlock } from "../../agents/sanitize-for-prompt.js";
import { SILENT_REPLY_TOKEN } from "../../auto-reply/tokens.js";
import type { CronFailureNotificationDelivery, CronJob } from "../types.js";

const REPAIR_PAYLOAD_MAX_CHARS = 4_000;
const REPAIR_ERROR_MAX_CHARS = 1_000;

/** Renders the last failure-alert delivery outcome so the brief says why no alert arrived. */
function describeAlertDelivery(delivery: CronFailureNotificationDelivery | undefined): string {
  if (!delivery) {
    return "No failure alert was sent.";
  }
  if (delivery.delivered) {
    return "The failure alert was delivered.";
  }
  // delivery.status is an internal enum. The transport error is untrusted
  // third-party content and is rendered separately as a data block (#186990).
  return `No failure alert was sent (last failure-alert delivery attempt: ${delivery.status}).`;
}

/** The settled transport error crosses into scheduler instructions, so it needs the data boundary. */
function alertDeliveryErrorBlocks(delivery: CronFailureNotificationDelivery | undefined): string[] {
  const reason = delivery && !delivery.delivered ? delivery.error?.trim() : undefined;
  if (!reason) {
    return [];
  }
  return [
    wrapUntrustedPromptDataBlock({
      label: "Last failure-alert delivery error",
      text: reason,
      maxChars: REPAIR_ERROR_MAX_CHARS,
      truncationMarker: " [truncated]",
    }),
  ];
}

/**
 * Renders a settled failed delivery outcome for an operator-facing fallback surface
 * (the in-app fallback notice), so the reason the alert did not arrive survives the
 * streak in which the earlier repair brief was already emitted (#186990).
 */
export function renderSettledFailureAlertDeliveryNote(
  delivery: CronFailureNotificationDelivery,
): string {
  return [describeAlertDelivery(delivery), ...alertDeliveryErrorBlocks(delivery)]
    .filter(Boolean)
    .join("\n");
}

export function buildCronFailureRepairBrief(params: {
  job: CronJob;
  consecutiveErrors: number;
  error?: string;
  errorReason?: FailoverReason;
  terminal?: boolean;
  /** Last known failure-alert delivery outcome from job state, when one exists. */
  alertDelivery?: CronFailureNotificationDelivery;
}): string {
  const { job } = params;
  const payload = job.payload;
  const payloadText =
    payload.kind === "agentTurn"
      ? payload.message
      : payload.kind === "systemEvent"
        ? payload.text
        : payload.kind === "script"
          ? payload.script
          : "";
  const error = [params.errorReason ? `cause: ${params.errorReason}` : "", params.error?.trim()]
    .filter(Boolean)
    .join("\n");
  const alertDeliveryLine = describeAlertDelivery(params.alertDelivery);
  return [
    `Automation repair request from the scheduler, not a user message. Do not relay it; follow the steps below.`,
    params.terminal
      ? `A one-time automation (id ${job.id}), created in this conversation, failed and will not run again (now disabled). ${alertDeliveryLine}`
      : `An automation (id ${job.id}), created in this conversation, failed ${params.consecutiveErrors} consecutive runs. ${alertDeliveryLine}`,
    ...alertDeliveryErrorBlocks(params.alertDelivery),
    `Schedule: ${JSON.stringify(job.schedule)}. Payload kind: ${payload.kind}.`,
    // Job text and provider errors can carry third-party content: data, never instructions.
    wrapUntrustedPromptDataBlock({ label: "Automation name", text: job.name, maxChars: 200 }),
    wrapUntrustedPromptDataBlock({
      label: "Current payload",
      text: payloadText,
      maxChars: REPAIR_PAYLOAD_MAX_CHARS,
      truncationMarker: " [truncated]",
    }),
    wrapUntrustedPromptDataBlock({
      label: "Last error",
      text: error || "No error text recorded.",
      maxChars: REPAIR_ERROR_MAX_CHARS,
      truncationMarker: " [truncated]",
    }),
    "",
    "Diagnose the failure, then do exactly one:",
    ...(params.terminal
      ? [
          `1. If its work is still needed, do that work now or add a new automation; the failed one stays disabled, so do not update it. To resume this conversation later, use automations add with an at schedule, payload {kind:"agentTurn",message:"instructions for your next turn"}, and sessionTarget ${JSON.stringify(`session:${job.owner?.sessionKey?.trim()}`)}.`,
          `2. If the work is no longer needed, reply with exactly ${SILENT_REPLY_TOKEN} as the entire final answer.`,
          "3. Otherwise, ask the user for what you need to continue.",
        ]
      : [
          `1. Transient (provider outage, network, rate limit, or temporary upstream error): change nothing and reply with exactly ${SILENT_REPLY_TOKEN} as the entire final answer.`,
          "2. Fixable in the workspace (for example the helper script or instructions file the payload follows): change it, then reply with one line saying what you changed. Do not claim the automation is fixed; a later run must verify it.",
          "3. Otherwise: ask the user for exactly what you need to fix it.",
          "If the automation keeps failing, the user gets the normal failure alert.",
        ]),
    `${SILENT_REPLY_TOKEN} discards anything written this turn that was not sent, so send confirmations before ending silently.`,
  ].join("\n");
}
