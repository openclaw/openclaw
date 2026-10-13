import { AsyncWorkScope } from "../shared/async-work-scope.js";
import {
  createCronServiceState,
  type CronServiceDeps,
  type CronServiceState,
} from "./service/state.js";
import { onTimer as runTimer } from "./service/timer.test-support.js";

/** Join independent scheduler ticks before checking or deleting the reaper's stores. */
export function createSessionReaperTimerHarness() {
  const scopes = new WeakMap<CronServiceState, AsyncWorkScope>();
  return {
    createState(this: void, deps: Omit<CronServiceDeps, "runSchedulerOwned">) {
      const scope = new AsyncWorkScope();
      const state = createCronServiceState({
        ...deps,
        runSchedulerOwned: (run) => scope.track(run),
      });
      scopes.set(state, scope);
      return state;
    },
    async onTimer(this: void, state: CronServiceState): Promise<void> {
      const scope = scopes.get(state);
      if (!scope) {
        throw new Error("Expected a reaper fixture-owned scheduler");
      }
      try {
        await runTimer(state);
      } finally {
        await scope.runWhenIdle(() => {});
      }
    },
  };
}
