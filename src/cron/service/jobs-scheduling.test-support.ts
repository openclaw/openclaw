import { isCronJobActive } from "../active-jobs.js";
import { recomputeSingleJobForMaintenance } from "./jobs-scheduling.js";
import type { CronServiceState } from "./state.js";

export function recomputeNextRunsForMaintenance(
  state: CronServiceState,
  opts: Parameters<typeof recomputeSingleJobForMaintenance>[2],
): boolean {
  if (!state.store) {
    return false;
  }
  let changed = false;
  for (const job of state.store.jobs) {
    changed =
      recomputeSingleJobForMaintenance(state, job, opts, {
        reservations: new Map(
          state.store.jobs.flatMap((entry) =>
            typeof entry.state.queuedAtMs === "number"
              ? [
                  [
                    entry.id,
                    { markerAtMs: entry.state.queuedAtMs, preserveWhenDisabled: true },
                  ] as const,
                ]
              : [],
          ),
        ),
        isJobActive: isCronJobActive,
      }) || changed;
  }
  return changed;
}
