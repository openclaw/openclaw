import { tryResolveCronJobEffectiveAgentId } from "../agent-id.js";
import type { CronSchedulerSnapshot } from "../store/scheduler-actor.types.js";
import type { CronServiceState } from "./state.js";

let snapshotVersion = 0;

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
    version: ++snapshotVersion,
    config: structuredClone({
      cronEnabled: state.deps.cronEnabled,
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
    }),
  };
}
