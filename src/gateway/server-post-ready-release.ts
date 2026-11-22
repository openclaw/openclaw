import type { ResourceProfile } from "../infra/gateway-resource-profile.js";
import type { GatewayScheduler } from "../infra/gateway-scheduler.js";
import {
  currentRootWork,
  getActiveGatewayRootWorkCount,
  type GatewayRootWorkAdmission,
} from "../process/gateway-work-admission-state.js";
import { createDeferredCore } from "../shared/deferred.js";

const POST_READY_WORK_START_DELAY_MS = 500;
// Lean holds post-ready work while requests run, so a first turn does not share its
// memory with the maintenance isolates that work starts. The cap bounds how long a
// continuously busy Gateway can postpone maintenance and cron.
export const LEAN_POST_READY_FIRST_CHECK_MS = 2_000;
export const LEAN_POST_READY_RETRY_MS = 1_000;
export const LEAN_POST_READY_MAX_DEFER_MS = 60_000;

const POST_READY_JOB_ID = "startup:post-ready-work";

/** Barrier for work that starts after readiness; roots waiting on it never hold it busy. */
export function createPostReadyWorkGate() {
  const { promise, resolve } = createDeferredCore();
  let released = false;
  const waiting = new Map<GatewayRootWorkAdmission, number>();
  return {
    wait: async (): Promise<void> => {
      const root = released ? undefined : currentRootWork.getStore();
      if (!root) {
        return await promise;
      }
      waiting.set(root, (waiting.get(root) ?? 0) + 1);
      try {
        await promise;
      } finally {
        const count = waiting.get(root)! - 1;
        if (count === 0) {
          waiting.delete(root);
        } else {
          waiting.set(root, count);
        }
      }
    },
    release: () => {
      released = true;
      resolve();
    },
    isBusy: () => getActiveGatewayRootWorkCount({ excludeCurrent: true, exclude: waiting }) > 0,
  };
}

/** Releases post-ready work after startup settles; lean waits for active requests first. */
export function schedulePostReadyWorkRelease(params: {
  scheduler: Pick<GatewayScheduler, "now" | "schedule">;
  profile: ResourceProfile;
  release: () => void;
  isClosing: () => boolean;
  isBusy: () => boolean;
}): void {
  if (params.profile !== "lean") {
    params.scheduler.schedule({
      id: POST_READY_JOB_ID,
      delayMs: POST_READY_WORK_START_DELAY_MS,
      run: params.release,
    });
    return;
  }
  const deadlineMs = params.scheduler.now() + LEAN_POST_READY_MAX_DEFER_MS;
  const check = (delayMs: number) => {
    params.scheduler.schedule({
      id: POST_READY_JOB_ID,
      delayMs,
      run: () => {
        if (params.isClosing()) {
          return;
        }
        const remainingMs = deadlineMs - params.scheduler.now();
        if (remainingMs > 0 && params.isBusy()) {
          check(Math.min(LEAN_POST_READY_RETRY_MS, remainingMs));
          return;
        }
        params.release();
      },
    });
  };
  check(LEAN_POST_READY_FIRST_CHECK_MS);
}
