import {
  type ScheduledOccurrence,
  unadmittedScheduledOccurrence,
} from "../scheduled-occurrence.js";
import type { CronStoredJob } from "../types.js";
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
