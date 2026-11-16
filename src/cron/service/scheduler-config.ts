import { DEFAULT_CRON_MAX_CONCURRENT_RUNS } from "../../config/cron-limits.js";
import { readCgroupMemoryHeadroomBytes, readHostFreeMemoryBytes } from "../../infra/host-memory.js";
import { readHostExecMemory } from "../../process/child-memory.js";
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
 * Free memory below which automation starts no further run while one is going, as GNU parallel's
 * `--memfree` does. Due jobs often come due together, and a drain starts all it may at once,
 * before their memory shows, so the threshold holds a full burst: 16 runs at the 256 MiB that
 * each command took in an 8 GiB container where, on main, eight runs started with about 1 GiB
 * left and 15 of 16 commands were OOM-killed.
 */
const CRON_RUN_MEMFREE_BYTES = DEFAULT_CRON_MAX_CONCURRENT_RUNS * 256 * 1024 ** 2;

/**
 * Run slots automation may hold right now: the fixed cron limit, or one while free memory is
 * under {@link CRON_RUN_MEMFREE_BYTES}, so a run always progresses and running ones are never
 * stopped. Free memory is the least of what the host has free or reclaimable, what the Gateway's
 * cgroup v2 limits leave (counting every process in them, not inactive file cache), and on Linux
 * what the exec memory budget leaves. Where the cgroup files cannot be read, as on cgroup v1, the
 * limit minus the Gateway's own memory stands in, which does not see other processes.
 */
export function resolveCronRunSlots(): number {
  const exec = readHostExecMemory();
  const limit = process.constrainedMemory();
  const free = Math.min(
    readHostFreeMemoryBytes(),
    readCgroupMemoryHeadroomBytes() ?? (limit > 0 ? limit - process.memoryUsage.rss() : Infinity),
    exec ? exec.budgetBytes - exec.usedBytes : Infinity,
  );
  return free < CRON_RUN_MEMFREE_BYTES ? 1 : DEFAULT_CRON_MAX_CONCURRENT_RUNS;
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
