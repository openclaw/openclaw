import type { ResourceProfile } from "../infra/gateway-resource-profile.js";
import type { GatewayScheduler } from "../infra/gateway-scheduler.js";
import { getActiveGatewayRootWorkCount } from "../process/gateway-work-admission-state.js";

const POST_READY_WORK_START_DELAY_MS = 500;
// Lean holds post-ready work while requests run, so a first turn does not share its
// memory with the maintenance isolates that work starts. The cap bounds how long a
// continuously busy Gateway can postpone maintenance and cron. Post-ready consumers wait
// for the barrier before admitting their own root work, so they never hold it busy.
export const LEAN_POST_READY_FIRST_CHECK_MS = 2_000;
export const LEAN_POST_READY_RETRY_MS = 1_000;
export const LEAN_POST_READY_MAX_DEFER_MS = 60_000;

const POST_READY_JOB_ID = "startup:post-ready-work";

/** Releases post-ready work after startup settles; lean waits for active requests first. */
export function schedulePostReadyWorkRelease(params: {
  scheduler: Pick<GatewayScheduler, "now" | "schedule">;
  profile: ResourceProfile;
  release: () => void;
  isClosing: () => boolean;
  isBusy?: () => boolean;
}): void {
  if (params.profile !== "lean") {
    params.scheduler.schedule({
      id: POST_READY_JOB_ID,
      delayMs: POST_READY_WORK_START_DELAY_MS,
      run: params.release,
    });
    return;
  }
  const isBusy =
    params.isBusy ?? (() => getActiveGatewayRootWorkCount({ excludeCurrent: true }) > 0);
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
        if (remainingMs > 0 && isBusy()) {
          check(Math.min(LEAN_POST_READY_RETRY_MS, remainingMs));
          return;
        }
        params.release();
      },
    });
  };
  check(LEAN_POST_READY_FIRST_CHECK_MS);
}
