import type { CronServiceState } from "./state.js";
import { armTimer } from "./timer-scheduler.js";

/** Arms the scheduler after a store-owned reload without creating an eager store cycle. */
export function armTimerAfterStoreReload(state: CronServiceState): void {
  armTimer(state);
}
