import {
  buildScheduledParentPauseNotice,
  type ScheduledOccurrence,
  unadmittedScheduledOccurrence,
} from "../scheduled-occurrence.js";
import type { CronJobExecutionResult, CronStoredJob } from "../types.js";
import type { CronServiceState } from "./state.js";

/** Admits one occurrence; every executor `executeJobCore` starts consumes this admission. */
export async function admitCronOccurrence(
  state: CronServiceState,
  job: CronStoredJob,
  agentId: string | undefined,
): Promise<ScheduledOccurrence> {
  if (!agentId) {
    return unadmittedScheduledOccurrence("automation has no effective agent");
  }
  if (!state.deps.admitScheduledOccurrence) {
    return unadmittedScheduledOccurrence("occurrence admission is not configured");
  }
  return await state.deps.admitScheduledOccurrence({ job });
}

/**
 * A paused occurrence runs nothing: no trigger script, payload or session. The
 * outcome owner disables the job and sends the notice once.
 */
export function resolvePausedOccurrence(
  job: CronStoredJob,
  occurrence: Pick<ScheduledOccurrence, "pause">,
): CronJobExecutionResult | undefined {
  // Admission only names real execution dependencies. A plain command has none;
  // a command with a parent-scoped grant or trigger must stop after that parent is removed.
  if (
    !occurrence.pause ||
    (job.payload.kind === "command" && occurrence.pause.reason !== "removed")
  ) {
    return undefined;
  }
  return {
    status: "skipped",
    error: buildScheduledParentPauseNotice({ job, pause: occurrence.pause }),
    parentUnavailable: occurrence.pause,
    executionStarted: false,
    delivered: false,
    deliveryAttempted: false,
  };
}
