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
  terminal?: boolean;
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
    params.terminal
      ? `A one-time automation (id ${job.id}), created in this conversation, failed and will not run again (now disabled). No failure alert was sent.`
      : `An automation (id ${job.id}), created in this conversation, failed ${params.consecutiveErrors} consecutive runs. No failure alert was sent.`,
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
          `2. If the work is no longer needed, reply exactly ${SILENT_REPLY_TOKEN}.`,
          "3. Otherwise, ask the user for what you need to continue.",
        ]
      : [
          `1. Transient (provider outage, network, rate limit, or temporary upstream error): change nothing and reply exactly ${SILENT_REPLY_TOKEN}.`,
          "2. Fixable in the workspace (for example the helper script or instructions file the payload follows): fix it, then reply with one line saying what you fixed.",
          "3. Otherwise: ask the user for exactly what you need to fix it.",
          "If the automation keeps failing, the user gets the normal failure alert.",
        ]),
  ].join("\n");
}
