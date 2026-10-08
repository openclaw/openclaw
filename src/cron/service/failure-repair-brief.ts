/** The repair request the scheduler posts into a failing automation's owner conversation. */
import type { FailoverReason } from "../../agents/failover/signal.js";
import { wrapUntrustedPromptDataBlock } from "../../agents/sanitize-for-prompt.js";
import { SILENT_REPLY_TOKEN } from "../../auto-reply/tokens.js";
import type { CronJob } from "../types.js";

const REPAIR_PAYLOAD_MAX_CHARS = 4_000;
const REPAIR_ERROR_MAX_CHARS = 1_000;

export function buildCronFailureRepairBrief(params: {
  job: CronJob;
  consecutiveErrors: number;
  error?: string;
  errorReason?: FailoverReason;
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
  return [
    `Automation repair request from the scheduler, not a user message. Do not relay it; follow the steps below.`,
    `An automation (id ${job.id}), created in this conversation, failed ${params.consecutiveErrors} consecutive runs. No failure alert was sent.`,
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
    `1. Transient (provider outage, network, rate limit, or temporary upstream error): change nothing and reply exactly ${SILENT_REPLY_TOKEN}.`,
    "2. Fixable in the workspace (for example the helper script or instructions file the payload follows): fix it, then reply with one line saying what you fixed.",
    "3. Otherwise: ask the user for exactly what you need to fix it.",
    "If the automation keeps failing, the user gets the normal failure alert.",
  ].join("\n");
}
