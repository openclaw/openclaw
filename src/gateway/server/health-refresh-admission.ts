import { isFutureDateTimestampMs } from "@openclaw/normalization-core/number-coercion";
import { HEALTH_REFRESH_INTERVAL_MS } from "../server-constants.js";
import type { GatewayRequestContext } from "../server-methods/types.js";

const backgroundRefreshStartedAt = new WeakMap<
  GatewayRequestContext["refreshHealthSnapshot"],
  number
>();

/** Shares the existing background cadence across connections and cached health reads. */
export function shouldScheduleBackgroundHealthRefresh(
  refresh: GatewayRequestContext["refreshHealthSnapshot"],
  now: number,
): boolean {
  const startedAt = backgroundRefreshStartedAt.get(refresh);
  if (
    startedAt !== undefined &&
    !isFutureDateTimestampMs(startedAt, { nowMs: now }) &&
    now - startedAt < HEALTH_REFRESH_INTERVAL_MS
  ) {
    return false;
  }
  // The lifecycle-owned function isolates independent Gateways without retaining them.
  backgroundRefreshStartedAt.set(refresh, now);
  return true;
}
