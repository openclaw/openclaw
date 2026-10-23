import { sliceToolResultTextToBudget } from "../agents/embedded-agent-runner/tool-result-text-budget.js";
import { SILENT_REPLY_TOKEN } from "../auto-reply/tokens.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { logWarn } from "../logger.js";
import {
  isExternalHookSession,
  mapHookExternalContentSource,
  type HookExternalContentSource,
} from "../security/external-content-source.js";
import { createLazyImportLoader } from "../shared/lazy-promise.js";
import { STARTUP_INTERRUPTED_ERROR } from "./execution-error-constants.js";
import type { CronJobScratchState } from "./scratch-contract.js";
import type { CronJob } from "./types.js";

const cronExternalContentRuntimeLoader = createLazyImportLoader(
  () => import("./isolated-agent/run-external-content.runtime.js"),
);

function appendCronUnattendedRunPreamble(
  commandBody: string,
  opts: { externalHook: boolean; restartContinuation?: boolean },
) {
  // Keep the suffix static for prompt caching. External hooks cannot override
  // this trusted guidance or gain permission to remove jobs through fenced content.
  const core = `This is an unattended scheduled run. Nobody is present to clarify or approve, so complete the task with what you have. Your final reply is the deliverable — not a plan, an acknowledgement, or a request for input. If nothing needs doing, reply with exactly ${SILENT_REPLY_TOKEN} as the entire final answer. ${SILENT_REPLY_TOKEN} discards anything written this turn that was not sent, so send confirmations before ending silently. If you cannot complete the task, explain what blocked it and what you tried.`;
  const trustedExtra =
    " Where the job's own instructions conflict with this preamble, the job's instructions win (a question or plan the job explicitly requests is a valid deliverable). If this job is no longer needed, remove it if your available tools allow.";
  const restartGuidance = opts.restartContinuation
    ? "\n\nThe previous attempt was interrupted by a Gateway restart. Continue the unfinished task. " +
      "Inspect the retained conversation and any tool effects before acting; do not repeat work or deliveries that already completed."
    : "";
  return `${commandBody}\n\n${core}${opts.externalHook ? "" : trustedExtra}${restartGuidance}`;
}

/** Builds the cron prompt while preserving hook wrapping and the stable unattended suffix. */
export async function buildCronCommandBody(params: {
  job: Pick<CronJob, "id" | "name" | "payload"> & Partial<Pick<CronJob, "state">>;
  cfg: OpenClawConfig;
  message: string;
  baseSessionKey: string;
  hookExternalContentSource?: HookExternalContentSource;
  formattedTime: string;
  timeLine: string;
}) {
  const { job, message, baseSessionKey, hookExternalContentSource, timeLine } = params;
  const sourcePromptPrefix = `[cron:${job.id} ${job.name}]`;
  const base = `${sourcePromptPrefix} ${message}`.trim();
  const isExternalHook =
    hookExternalContentSource !== undefined || isExternalHookSession(baseSessionKey);
  const allowUnsafeExternalContent =
    (job.payload.kind === "agentTurn" && job.payload.allowUnsafeExternalContent === true) ||
    (hookExternalContentSource === "gmail" &&
      params.cfg.hooks?.gmail?.allowUnsafeExternalContent === true);
  const shouldWrapExternal = isExternalHook && !allowUnsafeExternalContent;
  let commandBody: string;

  if (isExternalHook) {
    const { detectSuspiciousPatterns } = await cronExternalContentRuntimeLoader.load();
    const suspiciousPatterns = detectSuspiciousPatterns(message);
    if (suspiciousPatterns.length > 0) {
      logWarn(
        `[security] Suspicious patterns detected in external hook content ` +
          `(session=${baseSessionKey}, patterns=${suspiciousPatterns.length}): ${suspiciousPatterns.slice(0, 3).join(", ")}`,
      );
    }
  }

  if (shouldWrapExternal) {
    const { buildSafeExternalPrompt } = await cronExternalContentRuntimeLoader.load();
    const hookType = mapHookExternalContentSource(hookExternalContentSource ?? "webhook");
    const safeContent = buildSafeExternalPrompt({
      content: message,
      source: hookType,
      jobName: job.name,
      jobId: job.id,
      timestamp: params.formattedTime,
    });
    commandBody = `${safeContent}\n\n${timeLine}`.trim();
  } else {
    commandBody = `${base}\n${timeLine}`.trim();
  }
  commandBody = appendCronUnattendedRunPreamble(commandBody, {
    externalHook: isExternalHook,
    restartContinuation: job.state?.lastError === STARTUP_INTERRUPTED_ERROR,
  });
  return { sourcePromptPrefix, isExternalHook, commandBody };
}

/** The scratch owner injects one bounded revision and warns before a partial replacement. */
export function appendCronJobScratchPrompt(
  prompt: string,
  scratch: CronJobScratchState["scratch"],
): string {
  if (!scratch) {
    return prompt;
  }
  const bounded = sliceToolResultTextToBudget(scratch.content, 2000);
  return `${prompt}\n\nAutomation scratch (revision ${scratch.revision}):\n${bounded}${
    bounded !== scratch.content
      ? "\n[Scratch shortened for this prompt; reread the complete scratch before replacing it.]"
      : ""
  }`;
}
