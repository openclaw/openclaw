import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "../routing/account-id.js";
import { parseRawSessionConversationRef } from "../sessions/session-key-utils.js";
import {
  normalizeCronScheduledToolCallerOrigin,
  resolveCronScheduledToolPolicy,
} from "./scheduled-tool-policy.js";
import type { CronJob, CronStoredJob } from "./types.js";

type CronToolRuntimeSpec = Pick<CronJob, "payload" | "trigger">;

/** Returns whether a cron job can construct or execute OpenClaw agent tools. */
export function cronJobUsesToolRuntime(job: {
  payload?: { kind?: unknown };
  trigger?: { script?: unknown };
}): boolean {
  return (
    job.payload?.kind === "agentTurn" ||
    job.payload?.kind === "script" ||
    (typeof job.trigger?.script === "string" && job.trigger.script.trim().length > 0)
  );
}

/** Stamps an explicit unrestricted cap without changing jobs that already carry one. */
export function applyDefaultCronToolsAllow(job: CronToolRuntimeSpec): void {
  if (cronJobUsesToolRuntime(job) && job.payload.toolsAllow === undefined) {
    job.payload.toolsAllow = ["*"];
  }
}

/**
 * Older builds froze an automatic snapshot of the creator's tools, which could miss
 * tools the creator had. Such an agent turn runs like a `*` job, with its owner
 * conversation's tools. Condition triggers keep their list (scripts reach MCP only
 * through named servers), as do jobs without a valid owner policy or whose Codex app
 * authority is bound to the captured list.
 */
export function resolveCronRunToolsAllow(
  job: Pick<
    CronStoredJob,
    | "payload"
    | "trigger"
    | "owner"
    | "scheduledToolPolicy"
    | "runtimeAuthority"
    | "runtimeAuthorityRecoveryRequired"
  >,
): string[] | undefined {
  return job.payload.kind === "agentTurn" &&
    job.payload.toolsAllowIsDefault === true &&
    !job.trigger?.script.trim() &&
    !job.runtimeAuthority &&
    !job.runtimeAuthorityRecoveryRequired &&
    resolveCronScheduledToolPolicy({
      toolsAllow: job.payload.toolsAllow,
      scheduledToolPolicy: job.scheduledToolPolicy,
      owner: job.owner,
    })
    ? ["*"]
    : job.payload.toolsAllow;
}

/**
 * A job needs creator reauthorization when its account-scoped tool cap cannot
 * resolve a channel at run time. This mirrors the scheduled account liveness
 * guard, which only tool-runtime jobs reach: the owner account is named (not the
 * default), the recorded creator origin is unknown (an external origin carries
 * its channel and a local origin resolves via the delivery channel), and the
 * owner session key is not a group/channel ref (those parse to a channel). Such
 * jobs fail closed before the agent turn, script, or condition runs. Re-saving
 * the job's tool cap from the creator's authenticated turn records a fresh origin
 * and clears this state.
 */
export function cronJobNeedsCreatorReauthorization(params: {
  job: {
    payload?: { kind?: unknown; toolsAllow?: readonly string[] | undefined };
    trigger?: { script?: unknown };
    scheduledToolPolicy?: unknown;
    owner?: { sessionKey?: string; accountId?: string };
    toolsAllowProvenance?: { callerOrigin?: unknown };
  };
}): boolean {
  const { job } = params;
  if (!cronJobUsesToolRuntime(job) || job.payload?.toolsAllow === undefined) {
    return false;
  }
  const policy = resolveCronScheduledToolPolicy({
    toolsAllow: job.payload.toolsAllow,
    scheduledToolPolicy: job.scheduledToolPolicy,
    owner: job.owner,
  });
  if (policy?.mode !== "account") {
    return false;
  }
  if (normalizeAccountId(job.owner?.accountId) === DEFAULT_ACCOUNT_ID) {
    return false;
  }
  const origin = normalizeCronScheduledToolCallerOrigin(job.toolsAllowProvenance?.callerOrigin);
  if (origin.kind !== "unknown") {
    return false;
  }
  return parseRawSessionConversationRef(job.owner?.sessionKey)?.channel === undefined;
}
