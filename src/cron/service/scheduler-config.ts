import { listAgentDatabaseAdmissionRefusals } from "../../state/agent-database-admission.js";
import { tryResolveCronJobEffectiveAgentId } from "../agent-id.js";
import { currentPluginCommandHostProcessId } from "../plugin-command-schedule.js";
import type { CronSchedulerSnapshot } from "../store/scheduler-actor.types.js";
import type { CronServiceState } from "./state.js";

export function preparingCronAgentIds(env: NodeJS.ProcessEnv): string[] {
  return listAgentDatabaseAdmissionRefusals({ env })
    .filter((refusal) => refusal.code === "agent-database-inspection-pending")
    .map((refusal) => refusal.agentId);
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
    },
  };
}
