import { resolveScheduledPrincipal } from "./execution-context.js";
import type { CronStoredJob } from "./types.js";

type BindableJob = Parameters<typeof resolveScheduledPrincipal>[0] &
  Pick<CronStoredJob, "agentId" | "pluginCommand">;

/**
 * The parent key `automations bind` may record an incarnation for, or why it cannot.
 * Only jobs the execution-context builder classifies as `unbound-parent` qualify, so
 * binding never changes a job the builder already treats as operator or exact parent.
 */
export function resolveCronBindParent(
  job: BindableJob,
): { parentSessionKey: string } | { refusal: string } {
  if (job.pluginCommand) {
    return { refusal: "cron bind does not apply to plugin command automations." };
  }
  // `main` jobs run inside the agent's main session and record no creating conversation.
  if (job.sessionTarget === "main") {
    return { refusal: "cron bind does not apply to main-session automations." };
  }
  // The principal kind never depends on agentId; it only labels an exact parent's agent,
  // which bind does not read.
  const principal = resolveScheduledPrincipal(job, { trigger: "cron", agentId: job.agentId ?? "" });
  if ("error" in principal) {
    return { refusal: `cron bind cannot classify this automation: ${principal.error}.` };
  }
  if (principal.kind === "parent") {
    return { refusal: "cron bind: this automation is already bound to its parent conversation." };
  }
  if (principal.kind !== "unbound-parent") {
    return {
      refusal:
        "cron bind only applies to automations linked to a parent conversation by session key alone.",
    };
  }
  return { parentSessionKey: principal.parentSessionKey };
}

/** Store-owner check repeated at commit: bind fills only an absent link for the same parent. */
export function assertCronBindApplies(
  job: BindableJob,
  sourceConversation: NonNullable<CronStoredJob["sourceConversation"]>,
): void {
  const parent = resolveCronBindParent(job);
  if ("refusal" in parent) {
    throw new TypeError(parent.refusal);
  }
  if (parent.parentSessionKey !== sourceConversation.sessionKey) {
    throw new TypeError(
      "cron bind must run from this automation's parent conversation; this conversation is not its parent.",
    );
  }
}
