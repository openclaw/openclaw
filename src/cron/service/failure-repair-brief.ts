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
  /** The plain notice the user already has. */
  notice: string;
}): string {
  const { job } = params;
  const terminal = job.state.autoDisabled !== undefined;
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
    terminal
      ? `A one-time automation (id ${job.id}), created in this conversation, failed and will not run again (now disabled).`
      : `An automation (id ${job.id}), created in this conversation, failed${params.consecutiveErrors > 1 ? ` ${params.consecutiveErrors} runs in a row` : ""}.`,
    "The user already has this notice, which says what failed, what happens next and what to reply:",
    wrapUntrustedPromptDataBlock({
      label: "Notice sent to the user",
      text: params.notice,
      maxChars: 1_000,
    }),
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
    "Diagnose the failure, then do exactly one. Do not repeat the notice.",
    ...(terminal
      ? [
          `1. If its work is still needed, do that work now or add a new automation; the failed one stays disabled, so do not update it. To resume this conversation later, use automations add with an at schedule, payload {kind:"agentTurn",message:"instructions for your next turn"}, and sessionTarget ${JSON.stringify(`session:${job.owner?.sessionKey?.trim()}`)}.`,
          `2. If you have nothing to add to the notice, reply with exactly ${SILENT_REPLY_TOKEN} as the entire final answer.`,
          "3. Otherwise, ask the user for what you need to continue.",
        ]
      : [
          `1. Nothing to change (provider outage, network, rate limit, or temporary upstream error): reply with exactly ${SILENT_REPLY_TOKEN} as the entire final answer.`,
          "2. Fixable by you (the automation's trigger, payload, or the helper script or instructions file it follows): change it, then reply with one line saying what you changed. Do not claim the automation is fixed; its next attempt must verify it.",
          "3. Otherwise: tell the user in one or two plain sentences exactly what you need from them. Do not paste the raw error.",
          "If the same failure happens again, you will get this request again.",
        ]),
    `${SILENT_REPLY_TOKEN} discards anything written this turn that was not sent, so send confirmations before ending silently.`,
  ].join("\n");
}
