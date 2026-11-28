/** The early release recovery's readiness wait (see `update-early-release-recovery.ts`). */

import type { GatewayServiceControl } from "./update-early-release-recovery-service.js";

/** A boot migration of a large agent database runs before the Gateway reports ready. */
const READY_TIMEOUT_MS = 20 * 60_000;

/**
 * Waits for `probe` (the Gateway's `/readyz`). A migrating Gateway stays up while it works. One
 * that keeps exiting before it serves gives up when systemd fails its unit (the start limit, or
 * an exit it does not restart), or once the manager restarted it as often as that limit allows
 * starts: a boot that crashes later than systemd's window never reaches the limit itself, and
 * launchd's KeepAlive never gives up.
 */
export async function waitForGatewayReady(
  service: Pick<GatewayServiceControl, "state" | "failure" | "restarts" | "startLimit">,
  probe: () => Promise<boolean>,
  { now, log }: { now: () => number; log: (line: string) => void },
): Promise<boolean> {
  const burst = await service.startLimit();
  let first = await service.restarts();
  const until = now() + READY_TIMEOUT_MS;
  while (now() < until) {
    if (await probe()) {
      return true;
    }
    const [state, restarts] = [await service.state(), await service.restarts()];
    // A start that is not the manager's own restart resets the count.
    first = Math.min(first, restarts);
    if (state === "failed" || restarts - first >= burst) {
      const result = state === "failed" ? await service.failure() : "";
      log(
        `the Gateway service ${result ? `failed (${result})` : `restarted ${restarts - first} times`}`,
      );
      return false;
    }
  }
  return false;
}
