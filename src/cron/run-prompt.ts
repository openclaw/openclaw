import { sliceToolResultTextToBudget } from "../agents/embedded-agent-runner/tool-result-text-budget.js";
import { AUTOMATION_FAILED_TOKEN, SILENT_REPLY_TOKEN } from "../auto-reply/tokens.js";
import type { CronJobScratchState } from "./scratch-contract.js";

export function appendCronUnattendedRunPreamble(
  commandBody: string,
  opts: { externalHook: boolean },
) {
  // Keep the suffix static for prompt caching. External hooks cannot override
  // this trusted guidance or gain permission to remove jobs through fenced content.
  const core = `This is an unattended scheduled run. Nobody is present to clarify or approve, so complete the task with what you have. Your final reply is the deliverable — not a plan, an acknowledgement, or a request for input. If nothing needs doing, reply exactly ${SILENT_REPLY_TOKEN}. If something failed, start with ${AUTOMATION_FAILED_TOKEN} on its own line, then state what failed and what you tried — the scheduler owns retries and failure alerts.`;
  const trustedExtra =
    " Where the job's own instructions conflict with this preamble, the job's instructions win (a question or plan the job explicitly requests is a valid deliverable). If this job is no longer needed, remove it if your available tools allow.";
  return `${commandBody}\n\n${core}${opts.externalHook ? "" : trustedExtra}`;
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
