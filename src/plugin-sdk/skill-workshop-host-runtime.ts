// Bundled-only host facts for the Skill Workshop plugin, in the memory-core-host-* pattern.
// Core keeps the `skill_workshop_changes` table (schema, worker operations, per-agent row cap);
// the plugin records and lists rows here. The other exports are read-only host facts that have
// no public SDK contract yet.
import type { OpenClawConfig } from "../config/types.openclaw.js";

export { listWorkshopChanges, recordWorkshopChange } from "../skills/workshop-changes/changes.js";
export type {
  WorkshopActor,
  WorkshopChange,
  WorkshopChangeAction,
} from "../skills/workshop-changes/changes.kernel.js";
export { isInternalSessionEffectsKey } from "../config/sessions/internal-session-key.js";
export { isExpectedRunCancellation } from "../process/expected-run-cancellation.js";
export { canonicalizePath } from "../agents/utils/paths.js";
export { resolveEffectiveAgentRuntime } from "../agents/thinking-runtime.js";
/** Classifies a review failure; `rate_limit` backs off every queued review. */
export { resolveFailoverReasonFromError } from "../agents/failover-error.js";

/** True while any session run is active on this host; background reviews wait for quiet. */
export async function hasActiveSessionRuns(): Promise<boolean> {
  const { getActiveSessionRunCount } = await import("../sessions/session-controller.queries.js");
  return getActiveSessionRunCount() > 0;
}

/** The agent's configured sandbox mode ("off" when its runs read host paths). */
export async function resolveAgentSandboxMode(
  config: OpenClawConfig,
  agentId: string,
): Promise<string> {
  const { resolveSandboxConfigForAgent } = await import("../agents/sandbox/config.js");
  return resolveSandboxConfigForAgent(config, agentId).mode;
}

/** Text of every cron job payload, for keeping skills that scheduled work names. */
export async function readCronPayloadText(config: OpenClawConfig): Promise<string> {
  const [{ loadCronJobsStore }, { resolveCronJobsStorePathFromConfigAsync }] = await Promise.all([
    import("../cron/store.js"),
    import("../cron/store/paths.js"),
  ]);
  const store = await loadCronJobsStore(await resolveCronJobsStorePathFromConfigAsync(config));
  return store.jobs.map((job) => JSON.stringify(job.payload ?? {})).join("\n");
}

/** One tool-free model call on the agent's primary model (lazy; most turns never need it). */
export async function loadUtilityCompletion() {
  const { prepareUtilityCompletionForAgent, runUtilityCompletion } =
    await import("../agents/utility-completion.js");
  return { prepareUtilityCompletionForAgent, runUtilityCompletion };
}
// Fenced filesystem effects under the plugin's own skills root (versions, drafts, staging).
export { pathExists } from "../infra/fs-safe.js";
export { removePathWithinRoot } from "../infra/fs-safe-remove.js";
