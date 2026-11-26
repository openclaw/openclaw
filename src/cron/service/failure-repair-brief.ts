/** The repair request the scheduler posts into a failing automation's owner conversation. */
import type { FailoverReason } from "../../agents/failover/signal.js";
import { wrapUntrustedPromptDataBlock } from "../../agents/sanitize-for-prompt.js";
import { SILENT_REPLY_TOKEN } from "../../auto-reply/tokens.js";
import type { CronStagnationDisposition } from "../stagnation.js";
import type { CronJob } from "../types.js";

const REPAIR_PAYLOAD_MAX_CHARS = 4_000;
const REPAIR_ERROR_MAX_CHARS = 1_000;

function buildRecurringRepairSteps(params: {
  consecutiveErrors: number;
  stagnation?: CronStagnationDisposition;
}): string[] {
  if (params.stagnation === "authority_or_auth_gate") {
    return [
      `1. Do not leave the automation unchanged with ${SILENT_REPLY_TOKEN}. Do not switch models, providers, or accounts to bypass a denied permission, policy, or sign-in requirement, and do not silently downgrade the task.`,
      "2. If a workspace file or prompt mistake caused the automation to request the wrong tool or target within its existing permissions, fix it and reply with one line saying what you changed. Do not claim the automation is fixed; a later run must verify it.",
      "3. Otherwise: tell the user in one or two plain sentences what permission, sign-in, or billing action is needed to unblock this automation. Do not paste the raw error.",
    ];
  }
  if (params.stagnation === "explore_new_approach") {
    return [
      `1. Do not leave the automation unchanged with ${SILENT_REPLY_TOKEN}: this same failure has repeated across ${params.consecutiveErrors} runs after an earlier repair request.`,
      "2. If fixable in the workspace, apply a materially different fix than prior attempts without weakening permissions or silently downgrading the task, then reply with one line saying what you changed. Do not claim the automation is fixed; a later run must verify it.",
      "3. Otherwise: tell the user in one or two plain sentences what keeps failing and what decision or input you need from them. Do not paste the raw error.",
    ];
  }
  return [
    `1. Transient (provider outage, network, rate limit, or temporary upstream error): change nothing and reply with exactly ${SILENT_REPLY_TOKEN} as the entire final answer.`,
    "2. Fixable in the workspace (for example the helper script or instructions file the payload follows): change it, then reply with one line saying what you changed. Do not claim the automation is fixed; a later run must verify it.",
    "3. Otherwise: tell the user in one or two plain sentences what is broken and exactly what you need from them. Do not paste the raw error.",
    "If the same failure happens again, you will get this request again.",
  ];
}

export function buildCronFailureRepairBrief(params: {
  job: CronJob;
  consecutiveErrors: number;
  error?: string;
  errorReason?: FailoverReason;
  terminal?: boolean;
  stagnation?: CronStagnationDisposition;
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
      ? `A one-time automation (id ${job.id}), created in this conversation, failed and will not run again (now disabled). The user was not alerted; you are their notice.`
      : `An automation (id ${job.id}), created in this conversation, failed${params.consecutiveErrors > 1 ? ` ${params.consecutiveErrors} runs in a row` : ""}. The user was not alerted; you are their notice.`,
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
      : buildRecurringRepairSteps({
          consecutiveErrors: params.consecutiveErrors,
          stagnation: params.stagnation,
        })),
    `${SILENT_REPLY_TOKEN} discards anything written this turn that was not sent, so send confirmations before ending silently.`,
  ].join("\n");
}
