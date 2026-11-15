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
