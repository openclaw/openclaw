import { DEFAULT_CRON_MAX_CONCURRENT_RUNS } from "../../config/cron-limits.js";
import { readHostFreeMemoryBytes } from "../../infra/host-memory.js";
import { readHostExecMemory } from "../../process/child-memory.js";
import { getCommandLaneSnapshot } from "../../process/command-queue.js";
import { CommandLane } from "../../process/lanes.js";
import { isSessionRunActiveForKey } from "../../sessions/session-controller.queries.js";
import { listAgentDatabaseAdmissionRefusals } from "../../state/agent-database-admission.js";
import { tryResolveCronJobEffectiveAgentId } from "../agent-id.js";
import { currentPluginCommandHostProcessId } from "../plugin-command-schedule.js";
import { resolveCronContinuationSessionKey } from "../session-target.js";
import type { CronSchedulerSnapshot } from "../store/scheduler-actor.types.js";
import type { CronServiceState } from "./state.js";

export function preparingCronAgentIds(env: NodeJS.ProcessEnv): string[] {
  return listAgentDatabaseAdmissionRefusals({ env })
    .filter((refusal) => refusal.code === "agent-database-inspection-pending")
    .map((refusal) => refusal.agentId);
}

/**
 * Run slots automation may hold right now. Automation shares the agent concurrency limit with
 * conversations and yields to them: every conversation turn in progress takes one slot away, down
 * to the eight automation always keeps. Conversations are never held back by automation. Memory
 * can lower this further, down to one; see {@link resolveCronMemoryRunSlots}.
 */
export function resolveCronRunSlots(): number {
  const conversations = getCommandLaneSnapshot(CommandLane.Main);
  return Math.min(
    Math.max(
      DEFAULT_CRON_MAX_CONCURRENT_RUNS,
      conversations.maxConcurrent - conversations.activeCount,
    ),
    resolveCronMemoryRunSlots(),
  );
}

/**
 * The least memory one automation run is taken to use: its agent session, model streams, and the
 * tool processes it starts. When a recent exec command held more, that is the figure instead.
 */
const RUN_MEMORY_BYTES = 256 * 1024 * 1024;

/**
 * Runs that fit in half of the memory open to automation, at the per-run figure; at least one, so
 * automation always progresses, and runs already going are never stopped. Open memory is what is
 * free plus what running exec commands hold, so it does not depend on how many runs are going:
 * runs that just started, whose commands have not shown up as used yet, cannot use up the other
 * half however many times the queue is drained before they do.
 *
 * Host memory counts reclaimable cache as free. Under a container or cgroup limit, open memory is
 * that limit minus the Gateway's own: the cgroup's usage includes page cache the kernel would
 * reclaim, so on a long-running Gateway it reads as nearly full. Commands also stay within the
 * exec memory budget, past which the exec guard kills them.
 *
 * Accepted edge case: after a quiet period no recent command sets the figure, so a burst whose
 * commands are much larger than 256 MiB can still exceed the exec budget. The exec guard then
 * stops the largest command with an error naming the budget.
 */
function resolveCronMemoryRunSlots(): number {
  const exec = readHostExecMemory();
  const commands = exec?.usedBytes ?? 0;
  const limit = process.constrainedMemory();
  const open = Math.min(
    readHostFreeMemoryBytes() + commands,
    limit > 0 ? limit - process.memoryUsage.rss() : Infinity,
    exec ? exec.budgetBytes : Infinity,
  );
  const perRun = Math.max(RUN_MEMORY_BYTES, exec?.largestCommandBytes ?? 0);
  return Math.max(1, Math.floor(open / 2 / perRun));
}

/** The conversation a job's run would have to wait for right now, if its turn is still running. */
export function busyCronConversation(
  job: Parameters<typeof resolveCronContinuationSessionKey>[0],
): string | undefined {
  try {
    const conversation = resolveCronContinuationSessionKey(job);
    return conversation && isSessionRunActiveForKey(conversation) ? conversation : undefined;
  } catch {
    // An invalid session target is the launch's error to report, not every drain's.
    return undefined;
  }
}

/** Jobs whose run would only wait for the conversation it continues; see `cron.drainQueue`. */
export function busyConversationCronJobIds(state: CronServiceState): string[] {
  return (state.store?.jobs ?? [])
    .filter((job) => busyCronConversation(job) !== undefined)
    .map((job) => job.id);
}

/** Resolve host-only configuration before submitting any worker command. */
export async function captureCronSchedulerSnapshot(
  state: CronServiceState,
  configuredChannels?: readonly string[],
  preparedOwner?: { defaultAgentId: string | undefined },
): Promise<CronSchedulerSnapshot> {
  const channels = configuredChannels ?? (await state.deps.listConfiguredChannels?.());
  const needsDefault =
    !state.store || state.store.jobs.some((job) => !tryResolveCronJobEffectiveAgentId(job));
  return {
    config: {
      cronEnabled: state.deps.cronEnabled,
      preparingAgentIds: preparingCronAgentIds(state.deps.env),
      busyConversationJobIds: busyConversationCronJobIds(state),
      maxConcurrentRuns: resolveCronRunSlots(),
      cronConfig: state.deps.cronConfig,
      defaultAgentId: preparedOwner
        ? preparedOwner.defaultAgentId
        : needsDefault && state.deps.resolveDefaultAgentId
          ? state.deps.resolveDefaultAgentId()
          : state.deps.defaultAgentId,
      configuredChannels: channels ? [...channels] : undefined,
      maxMissedJobsPerRestart: state.deps.maxMissedJobsPerRestart,
      missedJobStaggerMs: state.deps.missedJobStaggerMs,
      startupDeferredMissedAgentJobDelayMs: state.deps.startupDeferredMissedAgentJobDelayMs,
      hostProcessId: currentPluginCommandHostProcessId(),
      pluginCommandHosts: state.deps.resolvePluginCommandScheduleHosts?.(),
    },
  };
}
