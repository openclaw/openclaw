// Control UI module implements usage cache status behavior.
import type { SessionsUsageResult } from "./data-types.ts";

type UsageCacheStatus = SessionsUsageResult["cacheStatus"];
export type UsageCacheState = NonNullable<UsageCacheStatus>["status"] | null;
export type UsageCacheDisplayState = "ready" | "rebuilding" | "paused";

export function getUsageCacheState(...statuses: UsageCacheStatus[]): UsageCacheState {
  const rank = { fresh: 0, partial: 1, stale: 2, refreshing: 3 } as const;
  let state: UsageCacheState = null;
  for (const cacheStatus of statuses) {
    if (cacheStatus && (state === null || rank[cacheStatus.status] > rank[state])) {
      state = cacheStatus.status;
    }
  }
  return state;
}

export function isUsageCacheIncomplete(state: UsageCacheState): boolean {
  return state !== null && state !== "fresh";
}

export function getUsageCacheDisplayState(
  state: UsageCacheState,
  autoRefreshPaused: boolean,
): UsageCacheDisplayState {
  if (!isUsageCacheIncomplete(state)) {
    return "ready";
  }
  return autoRefreshPaused ? "paused" : "rebuilding";
}
